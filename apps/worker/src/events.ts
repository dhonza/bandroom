import type { JobEvent } from "@bandroom/server-core";

const FLUSH_MS = 250;

/**
 * Forwards job events to the API (`POST /internal/events`), which fans them out over SSE.
 * Progress is coalesced per job to at most one event per flush interval; failures are logged and
 * dropped (the UI also refreshes from the API).
 */
export class EventForwarder {
  private queue: JobEvent[] = [];
  private readonly latestProgress = new Map<string, JobEvent>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly url: string,
    private readonly secret: string,
    private readonly onError: (err: unknown) => void,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  emit(event: JobEvent): void {
    const jobId = typeof event.data.jobId === "string" ? event.data.jobId : null;
    if (event.type === "job.progress" && jobId) this.latestProgress.set(jobId, event);
    else this.queue.push(event);
    this.timer ??= setTimeout(() => void this.flush(), FLUSH_MS);
  }

  async flush(): Promise<void> {
    this.timer = null;
    const events = [...this.latestProgress.values(), ...this.queue];
    this.latestProgress.clear();
    this.queue = [];
    if (events.length === 0) return;
    try {
      const res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": this.secret },
        body: JSON.stringify({ events }),
      });
      if (!res.ok) throw new Error(`internal events: HTTP ${res.status}`);
    } catch (err) {
      this.onError(err);
    }
  }
}
