// @vitest-environment node
import { describe, expect, it } from "vitest";
import { rangeResponse } from "./range";

const BYTES = Uint8Array.from({ length: 1000 }, (_, i) => i % 256);
const cached = () =>
  new Response(BYTES, {
    headers: { "Content-Type": "audio/ogg", ETag: '"abc"', "Content-Length": "1000" },
  });
const req = (range?: string) =>
  new Request("http://localhost/api/v1/blobs/x", range ? { headers: { Range: range } } : {});

async function bytes(res: Response): Promise<number[]> {
  return [...new Uint8Array(await res.arrayBuffer())];
}

describe("rangeResponse", () => {
  it("returns the whole cached response without a Range header", async () => {
    const res = await rangeResponse(req(), cached(), { "X-Bandroom-Cache": "1" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-bandroom-cache")).toBe("1");
    expect((await bytes(res)).length).toBe(1000);
  });

  it("answers a closed range with 206 and the exact bytes", async () => {
    const res = await rangeResponse(req("bytes=100-199"), cached());
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 100-199/1000");
    expect(res.headers.get("content-length")).toBe("100");
    expect(res.headers.get("content-type")).toBe("audio/ogg");
    expect(res.headers.get("etag")).toBe('"abc"');
    const b = await bytes(res);
    expect(b.length).toBe(100);
    expect(b[0]).toBe(100);
    expect(b[99]).toBe(199);
  });

  it("answers open-ended and suffix ranges (engine seeks, <audio> probes)", async () => {
    const open = await rangeResponse(req("bytes=0-"), cached());
    expect(open.status).toBe(206);
    expect(open.headers.get("content-range")).toBe("bytes 0-999/1000");
    expect((await bytes(open)).length).toBe(1000);

    const tail = await rangeResponse(req("bytes=900-"), cached());
    expect(tail.headers.get("content-range")).toBe("bytes 900-999/1000");
    expect((await bytes(tail))[0]).toBe(900 % 256);

    const suffix = await rangeResponse(req("bytes=-10"), cached());
    expect(suffix.headers.get("content-range")).toBe("bytes 990-999/1000");
    expect((await bytes(suffix)).length).toBe(10);
  });

  it("clamps an end past the file and rejects ranges outside it", async () => {
    const clamp = await rangeResponse(req("bytes=950-5000"), cached());
    expect(clamp.headers.get("content-range")).toBe("bytes 950-999/1000");
    const bad = await rangeResponse(req("bytes=1000-"), cached());
    expect(bad.status).toBe(416);
    expect(bad.headers.get("content-range")).toBe("bytes */1000");
    expect((await rangeResponse(req("items=0-1"), cached())).status).toBe(416);
  });
});
