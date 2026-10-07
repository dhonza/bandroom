import dns from "node:dns";
import http, { type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import net from "node:net";
import { pipeline, Transform, type Readable } from "node:stream";
import { isBlockedAddress } from "./ipClass";

/**
 * GET of a user-given URL from the server without opening an SSRF hole (SPEC §25.4):
 * - http/https only, no credentials in the URL, standard ports only;
 * - the host is resolved here and every address is checked; the connection then goes to exactly
 *   the vetted address (custom `lookup`), so a second DNS answer cannot swap in a private one;
 * - redirects are followed manually (at most `maxRedirects`), each hop checked the same way;
 * - an overall deadline, and the body is capped while streaming.
 */

export type SafeFetchErrorCode =
  | "INVALID_URL"
  | "BLOCKED"
  | "TOO_LARGE"
  | "TOO_MANY_REDIRECTS"
  | "HTTP_ERROR"
  | "TIMEOUT"
  | "NETWORK"
  | "NOT_IMAGE";

export class SafeFetchError extends Error {
  constructor(
    readonly code: SafeFetchErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SafeFetchError";
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface SafeFetchOptions {
  /** Largest body accepted; larger ones fail with `TOO_LARGE`. */
  maxBytes: number;
  /** Deadline for the whole fetch, body included. */
  timeoutMs: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Address policy; tests inject one that lets their local server through. */
  isBlocked?: (address: string) => boolean;
  /** DNS resolution (all addresses); tests inject fixed answers. */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  /** Ports that may be contacted; default 80 and 443 only. */
  allowedPorts?: ReadonlySet<number> | "any";
}

export interface SafeFetchResponse {
  /** The final URL after redirects. */
  url: string;
  status: number;
  headers: IncomingHttpHeaders;
  /** From Content-Length, when given. */
  contentLength: number | null;
  /** The capped body: errors with `TOO_LARGE` or `TIMEOUT` (a {@link SafeFetchError}). */
  body: Readable;
  /** Stops the transfer (e.g. when the caller rejects the response). */
  abort: () => void;
}

const DEFAULT_PORTS: ReadonlySet<number> = new Set([80, 443]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

async function systemResolve(hostname: string): Promise<ResolvedAddress[]> {
  const all = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return all.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
}

/** Parses and checks one hop's URL; returns it with its bare host (no IPv6 brackets). */
function checkUrl(
  raw: string | URL,
  ports: ReadonlySet<number> | "any",
): { url: URL; host: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeFetchError("INVALID_URL", "Not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new SafeFetchError("INVALID_URL", `Unsupported scheme ${url.protocol}`);
  if (url.username !== "" || url.password !== "")
    throw new SafeFetchError("INVALID_URL", "Credentials in URL");
  if (url.hostname === "") throw new SafeFetchError("INVALID_URL", "No host");
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (ports !== "any" && !ports.has(port))
    throw new SafeFetchError("BLOCKED", `Port ${String(port)} not allowed`);
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  return { url, host };
}

/** A `lookup` for http(s).request that resolves once and hands over only vetted addresses. */
function vettedLookup(
  resolve: (hostname: string) => Promise<ResolvedAddress[]>,
  isBlocked: (address: string) => boolean,
): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (found) => {
        const usable = found.filter((a) => !options.family || a.family === options.family);
        if (usable.length === 0) {
          callback(new SafeFetchError("NETWORK", `No address for ${hostname}`), "", 4);
          return;
        }
        // One private answer blocks the host: mixing public and private answers is a trick.
        if (found.some((a) => isBlocked(a.address))) {
          callback(
            new SafeFetchError("BLOCKED", `${hostname} resolves to a blocked address`),
            "",
            4,
          );
          return;
        }
        const first = usable[0] as ResolvedAddress;
        if (options.all) callback(null, usable);
        else callback(null, first.address, first.family);
      },
      (err: unknown) => {
        callback(new SafeFetchError("NETWORK", `DNS lookup failed: ${String(err)}`), "", 4);
      },
    );
  };
}

function requestOnce(
  url: URL,
  host: string,
  opts: Required<Pick<SafeFetchOptions, "isBlocked" | "resolve">> & {
    headers: Record<string, string>;
    signal: AbortSignal;
  },
): Promise<IncomingMessage> {
  if (net.isIP(host) !== 0 && opts.isBlocked(host))
    return Promise.reject(new SafeFetchError("BLOCKED", `${host} is a blocked address`));
  const mod = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(url, {
      method: "GET",
      headers: opts.headers,
      lookup: vettedLookup(opts.resolve, opts.isBlocked),
      agent: false,
      signal: opts.signal,
    });
    req.once("response", resolve);
    req.once("error", reject);
    req.end();
  });
}

function toSafeError(err: unknown, signal: AbortSignal): SafeFetchError {
  if (err instanceof SafeFetchError) return err;
  const reason: unknown = signal.reason;
  if (signal.aborted && reason instanceof SafeFetchError) return reason;
  if (signal.aborted) return new SafeFetchError("TIMEOUT", "Aborted");
  return new SafeFetchError("NETWORK", err instanceof Error ? err.message : String(err));
}

/** Fetches `rawUrl` under the rules above. Non-2xx answers fail with `HTTP_ERROR`. */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions,
): Promise<SafeFetchResponse> {
  const isBlocked = options.isBlocked ?? isBlockedAddress;
  const resolve = options.resolve ?? systemResolve;
  const ports = options.allowedPorts ?? DEFAULT_PORTS;
  const maxRedirects = options.maxRedirects ?? 3;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new SafeFetchError("TIMEOUT", "The fetch took too long"));
  }, options.timeoutMs);
  const onOuterAbort = () => {
    controller.abort(new SafeFetchError("NETWORK", "Cancelled"));
  };
  options.signal?.addEventListener("abort", onOuterAbort, { once: true });
  const done = () => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onOuterAbort);
  };
  const signal = controller.signal;

  try {
    let { url, host } = checkUrl(rawUrl, ports);
    for (let hop = 0; ; hop++) {
      const res = await requestOnce(url, host, {
        isBlocked,
        resolve,
        signal,
        headers: options.headers ?? {},
      });
      const status = res.statusCode ?? 0;
      if (REDIRECTS.has(status)) {
        res.resume();
        res.destroy();
        const location = res.headers.location;
        if (!location) throw new SafeFetchError("HTTP_ERROR", "Redirect without Location", status);
        if (hop >= maxRedirects)
          throw new SafeFetchError("TOO_MANY_REDIRECTS", "Too many redirects");
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          throw new SafeFetchError("INVALID_URL", "Invalid redirect");
        }
        ({ url, host } = checkUrl(next, ports));
        continue;
      }
      if (status < 200 || status > 299) {
        res.resume();
        res.destroy();
        throw new SafeFetchError("HTTP_ERROR", `HTTP ${String(status)}`, status);
      }
      const lengthHeader = res.headers["content-length"];
      const contentLength =
        lengthHeader !== undefined && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null;
      if (contentLength !== null && contentLength > options.maxBytes) {
        res.destroy();
        throw new SafeFetchError("TOO_LARGE", `Content-Length ${String(contentLength)}`);
      }
      let seen = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          seen += chunk.length;
          if (seen > options.maxBytes) cb(new SafeFetchError("TOO_LARGE", "Body too large"));
          else cb(null, chunk);
        },
      });
      const abort = () => {
        controller.abort(new SafeFetchError("NETWORK", "Cancelled"));
      };
      // A timeout during the body ends the stream with TIMEOUT rather than a bare abort error.
      signal.addEventListener("abort", () => {
        counter.destroy(toSafeError(signal.reason, signal));
      });
      pipeline(res, counter, (err) => {
        done();
        if (err && !counter.destroyed) counter.destroy(toSafeError(err, signal));
      });
      return { url: url.href, status, headers: res.headers, contentLength, body: counter, abort };
    }
  } catch (err) {
    const error = toSafeError(err, signal);
    done();
    controller.abort(error);
    throw error;
  }
}
