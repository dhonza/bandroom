import { parseRange } from "@bandroom/shared/range";

/**
 * Answers a request from a cached full response (SPEC §6.4, §13): the whole response without a
 * `Range` header, else `206 Partial Content` with the requested bytes, or `416` when the range
 * lies outside the file. The engine's decoder worker reads Opus/FLAC with Range requests and
 * `<audio>` probes with `bytes=0-`, so both must behave like the server's blob route.
 */
export async function rangeResponse(
  request: Request,
  cached: Response,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const header = request.headers.get("range");
  const headers = new Headers(cached.headers);
  for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
  if (!header) {
    return new Response(cached.body, {
      status: cached.status,
      statusText: cached.statusText,
      headers,
    });
  }
  const body = await cached.blob();
  const size = body.size;
  const range = parseRange(header, size);
  headers.set("Accept-Ranges", "bytes");
  if (range === null) {
    headers.set("Content-Length", String(size));
    return new Response(body, { status: 200, headers });
  }
  if (range === "invalid") {
    headers.set("Content-Range", `bytes */${size}`);
    headers.delete("Content-Length");
    return new Response(null, { status: 416, statusText: "Range Not Satisfiable", headers });
  }
  headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
  headers.set("Content-Length", String(range.end - range.start + 1));
  return new Response(body.slice(range.start, range.end + 1, body.type), {
    status: 206,
    statusText: "Partial Content",
    headers,
  });
}
