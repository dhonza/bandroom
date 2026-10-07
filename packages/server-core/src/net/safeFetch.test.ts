import http from "node:http";
import type { AddressInfo } from "node:net";
import { buffer } from "node:stream/consumers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchImage, sniffImageType } from "./fetchImage";
import { isBlockedAddress } from "./ipClass";
import {
  safeFetch,
  SafeFetchError,
  type ResolvedAddress,
  type SafeFetchOptions,
} from "./safeFetch";

const PNG = Buffer.concat([
  Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
  Buffer.alloc(200, 7),
]);
let server: http.Server;
let port = 0;
let hits: string[] = [];

/** Fake DNS: test names resolve to fixed answers; the local server is at 127.0.0.1. */
const DNS: Record<string, ResolvedAddress[]> = {
  "img.test": [{ address: "127.0.0.1", family: 4 }],
  "evil.test": [{ address: "10.0.0.1", family: 4 }],
  "mixed.test": [
    { address: "127.0.0.1", family: 4 },
    { address: "169.254.169.254", family: 4 },
  ],
  "meta.test": [{ address: "::ffff:169.254.169.254", family: 6 }],
};
const resolve = (host: string) => {
  const found = DNS[host];
  return found ? Promise.resolve(found) : Promise.reject(new Error(`ENOTFOUND ${host}`));
};
/** The real policy, except that the test server's address is let through. */
const isBlocked = (ip: string) => ip !== "127.0.0.1" && isBlockedAddress(ip);
const opts = (extra: Partial<SafeFetchOptions> = {}): SafeFetchOptions => ({
  maxBytes: 1000,
  timeoutMs: 2000,
  isBlocked,
  resolve,
  allowedPorts: "any",
  ...extra,
});
const at = (path: string, host = "img.test") => `http://${host}:${String(port)}${path}`;

async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof SafeFetchError) return err.code;
    throw err;
  }
  return "ok";
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    hits.push(url);
    const m = /^\/redirect\/(\d+)$/.exec(url);
    if (m) {
      const n = Number(m[1]);
      res.writeHead(302, { location: n > 0 ? `/redirect/${String(n - 1)}` : "/png" }).end();
    } else if (url === "/png") res.writeHead(200, { "content-type": "image/png" }).end(PNG);
    else if (url === "/to-private") res.writeHead(301, { location: "http://10.0.0.5/x" }).end();
    else if (url === "/to-evil")
      res.writeHead(307, { location: `http://evil.test:${String(port)}/png` }).end();
    else if (url === "/to-meta") res.writeHead(302, { location: "http://[::1]/x" }).end();
    else if (url === "/to-ftp") res.writeHead(302, { location: "ftp://img.test/x" }).end();
    else if (url === "/no-location") res.writeHead(302).end();
    else if (url === "/big-declared")
      res.writeHead(200, { "content-type": "image/png", "content-length": "5000" }).end();
    else if (url === "/big-chunked") {
      res.writeHead(200, { "content-type": "image/png" });
      res.write(PNG);
      res.write(Buffer.alloc(900));
      res.end(Buffer.alloc(900));
    } else if (url === "/html") res.writeHead(200, { "content-type": "text/html" }).end("<html>");
    else if (url === "/fake-png")
      res.writeHead(200, { "content-type": "image/png" }).end("<html><body>not a png</body>");
    else if (url === "/hang") {
      // never answers
    } else if (url === "/slow-body") {
      res.writeHead(200, { "content-type": "image/png" });
      res.write(PNG);
      // the rest never comes
    } else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

describe("safeFetch (SPEC §25.4)", () => {
  it("connects to the vetted address of a resolved name", async () => {
    const res = await safeFetch(at("/png"), opts());
    expect(res.status).toBe(200);
    expect(await buffer(res.body)).toEqual(PNG);
  });

  it("follows up to three redirects, then refuses", async () => {
    const res = await safeFetch(at("/redirect/2"), opts());
    expect(res.url).toBe(at("/png"));
    expect(await buffer(res.body)).toEqual(PNG);
    expect(await failure(safeFetch(at("/redirect/3"), opts()))).toBe("TOO_MANY_REDIRECTS");
    expect(await failure(safeFetch(at("/redirect/1"), opts({ maxRedirects: 1 })))).toBe(
      "TOO_MANY_REDIRECTS",
    );
  });

  it("checks every redirect hop", async () => {
    hits = [];
    expect(await failure(safeFetch(at("/to-private"), opts()))).toBe("BLOCKED");
    expect(await failure(safeFetch(at("/to-evil"), opts()))).toBe("BLOCKED");
    expect(await failure(safeFetch(at("/to-meta"), opts()))).toBe("BLOCKED");
    expect(await failure(safeFetch(at("/to-ftp"), opts()))).toBe("INVALID_URL");
    expect(await failure(safeFetch(at("/no-location"), opts()))).toBe("HTTP_ERROR");
    // The blocked targets were never contacted (only the redirecting URLs were).
    expect(hits).toEqual(["/to-private", "/to-evil", "/to-meta", "/to-ftp", "/no-location"]);
  });

  it("refuses blocked literals, names resolving to blocked addresses and odd URLs", async () => {
    const real = { ...opts(), isBlocked: isBlockedAddress };
    expect(await failure(safeFetch(`http://127.0.0.1:${String(port)}/png`, real))).toBe("BLOCKED");
    expect(await failure(safeFetch(`http://[::1]:${String(port)}/png`, opts()))).toBe("BLOCKED");
    expect(await failure(safeFetch("http://169.254.169.254/latest/meta-data", opts()))).toBe(
      "BLOCKED",
    );
    expect(await failure(safeFetch(at("/png"), real))).toBe("BLOCKED");
    expect(await failure(safeFetch(at("/png", "evil.test"), opts()))).toBe("BLOCKED");
    expect(await failure(safeFetch(at("/png", "mixed.test"), opts()))).toBe("BLOCKED");
    expect(await failure(safeFetch(at("/png", "meta.test"), opts()))).toBe("BLOCKED");
    expect(await failure(safeFetch(at("/png", "nowhere.test"), opts()))).toBe("NETWORK");
    expect(await failure(safeFetch("file:///etc/passwd", opts()))).toBe("INVALID_URL");
    expect(await failure(safeFetch("gopher://img.test/", opts()))).toBe("INVALID_URL");
    expect(await failure(safeFetch("not a url", opts()))).toBe("INVALID_URL");
    expect(await failure(safeFetch(`http://user:pw@img.test:${String(port)}/png`, opts()))).toBe(
      "INVALID_URL",
    );
  });

  it("allows only ports 80 and 443 by default", async () => {
    const { allowedPorts: _any, ...defaults } = opts();
    expect(await failure(safeFetch(at("/png"), defaults))).toBe("BLOCKED");
    expect(await failure(safeFetch("http://img.test:22/", defaults))).toBe("BLOCKED");
  });

  it("caps the size by Content-Length and while streaming", async () => {
    expect(await failure(safeFetch(at("/big-declared"), opts()))).toBe("TOO_LARGE");
    const res = await safeFetch(at("/big-chunked"), opts());
    expect(await failure(buffer(res.body))).toBe("TOO_LARGE");
  });

  it("times out while waiting and while streaming", async () => {
    expect(await failure(safeFetch(at("/hang"), opts({ timeoutMs: 200 })))).toBe("TIMEOUT");
    const res = await safeFetch(at("/slow-body"), opts({ timeoutMs: 300 }));
    expect(await failure(buffer(res.body))).toBe("TIMEOUT");
  });

  it("reports HTTP errors and refused connections", async () => {
    expect(await failure(safeFetch(at("/missing"), opts()))).toBe("HTTP_ERROR");
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise((r) => closed.close(r));
    expect(await failure(safeFetch(`http://img.test:${String(closedPort)}/`, opts()))).toBe(
      "NETWORK",
    );
  });

  it("stops when the caller aborts", async () => {
    const ac = new AbortController();
    const p = safeFetch(at("/hang"), opts({ signal: ac.signal }));
    setTimeout(() => {
      ac.abort();
    }, 50);
    expect(await failure(p)).toBe("NETWORK");
  });
});

describe("fetchImage", () => {
  it("streams a sniffed image", async () => {
    const img = await fetchImage(at("/png"), opts());
    expect(img.mime).toBe("image/png");
    expect(await buffer(img.stream)).toEqual(PNG);
  });

  it("refuses non-image types and bodies that are not images", async () => {
    expect(await failure(fetchImage(at("/html"), opts()))).toBe("NOT_IMAGE");
    expect(await failure(fetchImage(at("/fake-png"), opts()))).toBe("NOT_IMAGE");
  });
});

describe("sniffImageType", () => {
  const ftyp = (major: string, ...compatible: string[]) => {
    const brands = [major, "\0\0\0\0", ...compatible].join("");
    const size = Buffer.alloc(4);
    size.writeUInt32BE(8 + brands.length);
    return Buffer.concat([size, Buffer.from(`ftyp${brands}`, "latin1")]);
  };
  it("knows PNG, JPEG, GIF, WebP and AVIF", () => {
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageType(Buffer.from("GIF89a..."))).toBe("image/gif");
    expect(sniffImageType(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffImageType(ftyp("avif", "mif1", "miaf"))).toBe("image/avif");
    expect(sniffImageType(ftyp("mif1", "miaf", "avif"))).toBe("image/avif");
    expect(sniffImageType(ftyp("heic", "mif1"))).toBeNull();
    expect(sniffImageType(ftyp("isom", "mp41"))).toBeNull();
    expect(sniffImageType(Buffer.from("<svg xmlns="))).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });
});
