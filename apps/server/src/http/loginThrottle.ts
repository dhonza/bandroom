/**
 * Login brute-force protection (SPEC §3.1): at most 5 failures per username per 15 minutes, and
 * exponential backoff per IP. In memory (single API process) with a hard size cap (SPEC §19.6).
 */
export interface ThrottleOptions {
  maxPerUsername: number;
  windowMs: number;
  /** Failures from one IP (any username) tolerated before backoff starts. */
  ipFreeFailures: number;
  ipMaxBackoffMs: number;
  maxEntries: number;
}

export const DEFAULT_THROTTLE: ThrottleOptions = {
  maxPerUsername: 5,
  windowMs: 15 * 60 * 1000,
  ipFreeFailures: 10,
  ipMaxBackoffMs: 15 * 60 * 1000,
  maxEntries: 10_000,
};

/**
 * Per-link lockout for link passwords (review L5): many failures on one link from any number of
 * IPs lock it for everyone until the window passes. IP backoff stays with the per-IP throttle.
 */
export const LINK_LOCKOUT_THROTTLE: ThrottleOptions = {
  ...DEFAULT_THROTTLE,
  maxPerUsername: 50,
  ipFreeFailures: Number.POSITIVE_INFINITY,
  maxEntries: 1_000,
};

interface Entry {
  failures: number[];
}

export class LoginThrottle {
  private readonly byUser = new Map<string, Entry>();
  private readonly byIp = new Map<string, Entry>();

  constructor(private readonly opts: ThrottleOptions = DEFAULT_THROTTLE) {}

  /** Milliseconds until another attempt is allowed, or 0. */
  retryAfterMs(username: string, ip: string, now: number = Date.now()): number {
    const user = this.recent(this.byUser, username, now);
    let wait = 0;
    if (user.length >= this.opts.maxPerUsername) {
      wait = (user[0] ?? now) + this.opts.windowMs - now;
    }
    const ipFailures = this.recent(this.byIp, ip, now);
    const excess = ipFailures.length - this.opts.ipFreeFailures;
    if (excess >= 0) {
      const backoff = Math.min(1000 * 2 ** excess, this.opts.ipMaxBackoffMs);
      const last = ipFailures[ipFailures.length - 1] ?? now;
      wait = Math.max(wait, last + backoff - now);
    }
    return Math.max(0, wait);
  }

  recordFailure(username: string, ip: string, now: number = Date.now()): void {
    this.push(this.byUser, username, now);
    this.push(this.byIp, ip, now);
  }

  recordSuccess(username: string): void {
    this.byUser.delete(username);
  }

  private recent(map: Map<string, Entry>, key: string, now: number): number[] {
    const e = map.get(key);
    if (!e) return [];
    e.failures = e.failures.filter((t) => t > now - this.opts.windowMs);
    if (e.failures.length === 0) map.delete(key);
    return e.failures;
  }

  private push(map: Map<string, Entry>, key: string, now: number): void {
    const e = map.get(key) ?? { failures: [] };
    e.failures.push(now);
    map.delete(key); // re-insert to keep Map order = recency
    map.set(key, e);
    while (map.size > this.opts.maxEntries) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
}
