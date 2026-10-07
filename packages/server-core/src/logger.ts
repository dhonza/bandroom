import { pino, type Logger, type LoggerOptions } from "pino";
import type { Config } from "./config";

/** Paths that must never reach the logs (SPEC §18.6). */
export const LOG_REDACT_PATHS = [
  "req.headers.cookie",
  "req.headers.authorization",
  'res.headers["set-cookie"]',
  "*.password",
  "*.passwordHash",
  "*.token",
];

const CENSOR = "[redacted]";

/**
 * URL segments that are bearer secrets: public links (`/l/<token>`, also below `/api/v1/l/`),
 * invites and password resets (SPA and API paths). Anyone reading the logs could open them.
 */
const TOKEN_SEGMENT = /\/(l|invite|invites|reset|password-resets)\/[^/?#]+/g;

/** Replaces token segments of a request URL with `[redacted]`. */
export function redactUrl(url: string): string {
  return url.replace(TOKEN_SEGMENT, (_match, prefix: string) => `/${prefix}/${CENSOR}`);
}

interface LoggedRequest {
  method?: string;
  url?: string;
  host?: string;
  ip?: string;
  headers?: Record<string, unknown>;
  socket?: { remotePort?: number };
}

/** Same fields as Fastify's default `req` serializer, with the URL's tokens redacted. */
function serializeRequest(req: LoggedRequest) {
  return {
    method: req.method,
    url: typeof req.url === "string" ? redactUrl(req.url) : req.url,
    version: req.headers?.["accept-version"],
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  };
}

export function loggerOptions(config: Pick<Config, "logLevel">, name: string): LoggerOptions {
  return {
    name,
    level: config.logLevel,
    redact: { paths: LOG_REDACT_PATHS, censor: CENSOR },
    // Fastify merges a logger instance's serializers over its defaults.
    serializers: { req: serializeRequest },
  };
}

export function createLogger(config: Pick<Config, "logLevel">, name: string): Logger {
  return pino(loggerOptions(config, name));
}
