import type {
  Config,
  Db,
  SafeFetchOptions,
  StorageBackend,
  ToolPaths,
} from "@bandroom/server-core";
import type { EventHub } from "./realtime/hub";
import type { CookieSettings } from "./http/session";
import type { LoginThrottle } from "./http/loginThrottle";
import type { SlotLimiter } from "./http/slotLimiter";

/** Dependencies shared by route modules. */
export interface AppContext {
  config: Config;
  db: Db;
  cookies: CookieSettings;
  throttle: LoginThrottle;
  /** Wrong link passwords per link and IP, plus per-IP backoff (SPEC §18.6). */
  linkThrottle: LoginThrottle;
  /** Wrong link passwords per link from all IPs (review L5); keyed on the link id. */
  linkLockout: LoginThrottle;
  version: string;
  storage: StorageBackend;
  tools: ToolPaths;
  hub: EventHub;
  /** ffmpeg processes the API may run at once (WAV downloads; SPEC §19.6: one). */
  ffmpegSlots: SlotLimiter;
  /** Samply API access (overridable in tests/e2e). */
  samply: SamplyOptions;
  /** Image URL fetches (SPEC §25.4); tests inject DNS and an address policy for a local server. */
  imageFetch: ImageFetchOptions;
}

export type ImageFetchOptions = Pick<SafeFetchOptions, "isBlocked" | "resolve" | "allowedPorts"> & {
  timeoutMs?: number;
};

export interface SamplyOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  minIntervalMs?: number;
  backoffMs?: number;
}

/** Absolute URL of a client-side route, e.g. `appLink(ctx, "/invite/abc")`. */
export function appLink(ctx: Pick<AppContext, "config">, path: string): string {
  return `${ctx.config.appUrl.replace(/\/+$/, "")}${path}`;
}
