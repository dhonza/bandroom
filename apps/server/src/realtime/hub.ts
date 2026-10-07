import type { StreamEvent } from "@bandroom/shared";

export const REPLAY_MS = 5 * 60_000;
const REPLAY_MAX = 2000;
/** Open streams per user; the oldest is closed when a new one would exceed it (SPEC §19.6). */
export const MAX_CLIENTS_PER_USER = 10;

export interface HubClient {
  /** Decides whether this client may receive an event (permission filter, SPEC §18.5). */
  canSee(event: StreamEvent): boolean;
  send(frame: string): void;
  /** Owner of the connection, for the per-user cap and {@link EventHub.revalidateUser}. */
  userId?: string;
  /** Re-checks the connection's session; false closes it. */
  stillValid?(): boolean;
  /** Ends the underlying connection. */
  close?(): void;
}

interface Buffered {
  id: number;
  ts: number;
  event: StreamEvent;
}

export function formatSse(id: number, event: StreamEvent): string {
  return `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function safely(check: () => boolean): boolean {
  try {
    return check();
  } catch {
    return false;
  }
}

/**
 * In-memory SSE fan-out with a bounded 5-minute replay buffer for reconnects (`Last-Event-ID`).
 * Single API process, so no external broker is needed.
 */
export class EventHub {
  private nextId = 1;
  private readonly buffer: Buffered[] = [];
  private readonly clients = new Set<HubClient>();

  publish(event: StreamEvent, now: number = Date.now()): number {
    const id = this.nextId++;
    this.buffer.push({ id, ts: now, event });
    while (
      this.buffer.length > REPLAY_MAX ||
      (this.buffer[0] && this.buffer[0].ts < now - REPLAY_MS)
    ) {
      this.buffer.shift();
    }
    const frame = formatSse(id, event);
    for (const c of this.clients) {
      try {
        if (c.canSee(event)) c.send(frame);
      } catch {
        this.drop(c);
      }
    }
    return id;
  }

  /** Closes a user's connections whose session no longer holds (logout, revocation, disable). */
  revalidateUser(userId: string): void {
    for (const c of this.clients) {
      if (c.userId === userId && c.stillValid && !safely(() => c.stillValid?.() ?? true)) {
        this.drop(c);
      }
    }
  }

  /** Closes every connection (server shutdown: hijacked streams would keep it waiting). */
  closeAll(): void {
    for (const c of this.clients) this.drop(c);
  }

  /** Adds a client and replays buffered events after `lastEventId` it may see. */
  subscribe(client: HubClient, lastEventId: number | null): () => void {
    if (lastEventId !== null) {
      for (const b of this.buffer) {
        if (b.id > lastEventId && client.canSee(b.event)) client.send(formatSse(b.id, b.event));
      }
    }
    if (client.userId !== undefined) {
      const own = [...this.clients].filter((c) => c.userId === client.userId);
      // Set order is insertion order, so the first ones are the oldest.
      for (const c of own.slice(0, Math.max(0, own.length - MAX_CLIENTS_PER_USER + 1))) {
        this.drop(c);
      }
    }
    this.clients.add(client);
    return () => {
      this.clients.delete(client);
    };
  }

  private drop(client: HubClient): void {
    this.clients.delete(client);
    try {
      client.close?.();
    } catch {
      // Already gone.
    }
  }

  get size(): number {
    return this.clients.size;
  }
}
