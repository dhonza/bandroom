import { describe, expect, it, vi } from "vitest";
import { EventForwarder } from "./events";

describe("EventForwarder", () => {
  it("coalesces progress per job and posts with the secret", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const f = new EventForwarder(
      "http://api/internal/events",
      "s3cret",
      () => undefined,
      fetchImpl,
    );
    f.emit({ type: "job.progress", data: { jobId: "a", progress: 0.1 } });
    f.emit({ type: "job.progress", data: { jobId: "a", progress: 0.5 } });
    f.emit({ type: "asset.ready", data: { jobId: "a" } });
    await f.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("http://api/internal/events");
    expect((init?.headers as Record<string, string>)["X-Internal-Secret"]).toBe("s3cret");
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      events: { type: string; data: { progress?: number } }[];
    };
    expect(body.events.map((e) => [e.type, e.data.progress])).toEqual([
      ["job.progress", 0.5],
      ["asset.ready", undefined],
    ]);
  });

  it("reports delivery errors without throwing", async () => {
    const onError = vi.fn();
    const f = new EventForwarder(
      "http://x",
      "s",
      onError,
      vi.fn<typeof fetch>().mockRejectedValue(new Error("down")),
    );
    f.emit({ type: "asset.ready", data: {} });
    await f.flush();
    expect(onError).toHaveBeenCalled();
  });
});
