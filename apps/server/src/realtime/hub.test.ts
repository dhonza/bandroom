import { describe, expect, it } from "vitest";
import { EventHub, REPLAY_MS } from "./hub";

function client(filter: (songId: string | null | undefined) => boolean = () => true) {
  const frames: string[] = [];
  return {
    frames,
    canSee: (e: { songId?: string | null }) => filter(e.songId),
    send: (f: string) => frames.push(f),
  };
}

describe("EventHub", () => {
  it("fans out events filtered per client", () => {
    const hub = new EventHub();
    const all = client();
    const onlyA = client((s) => s === "a");
    hub.subscribe(all, null);
    hub.subscribe(onlyA, null);
    hub.publish({ type: "job.progress", songId: "a", data: { p: 1 } });
    hub.publish({ type: "job.progress", songId: "b", data: { p: 2 } });
    expect(all.frames).toHaveLength(2);
    expect(onlyA.frames).toEqual([
      `id: 1\nevent: job.progress\ndata: ${JSON.stringify({ type: "job.progress", songId: "a", data: { p: 1 } })}\n\n`,
    ]);
  });

  it("replays after Last-Event-ID within the window, and unsubscribes", () => {
    const hub = new EventHub();
    hub.publish({ type: "x", data: {} }, 0);
    hub.publish({ type: "y", data: {} }, 1000);
    const c = client();
    const off = hub.subscribe(c, 1);
    expect(c.frames).toHaveLength(1);
    expect(c.frames[0]).toContain("event: y");
    off();
    hub.publish({ type: "z", data: {} }, 2000);
    expect(c.frames).toHaveLength(1);
    // Old events drop out of the replay buffer.
    hub.publish({ type: "late", data: {} }, 2000 + REPLAY_MS + 1);
    const d = client();
    hub.subscribe(d, 0);
    expect(d.frames.map((f) => /event: (\w+)/.exec(f)?.[1])).toEqual(["late"]);
  });

  it("drops clients whose send throws", () => {
    const hub = new EventHub();
    hub.subscribe(
      {
        canSee: () => true,
        send: () => {
          throw new Error("closed");
        },
      },
      null,
    );
    hub.publish({ type: "x", data: {} });
    expect(hub.size).toBe(0);
  });
});
