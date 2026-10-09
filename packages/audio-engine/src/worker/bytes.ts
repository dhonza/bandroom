/**
 * Compressed bytes of one blob, kept as the pieces the network delivered (SPEC §6.4). Opus files
 * fill up completely over time (unless too big for the budget); FLAC keeps only blocks near the
 * playhead.
 */
export class SparseFile {
  /** Sorted, non-overlapping pieces. */
  private pieces: { start: number; bytes: Uint8Array }[] = [];
  size: number | null = null;
  stored = 0;

  add(start: number, bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    // Trim against existing pieces so they never overlap.
    let s = start;
    let b = bytes;
    // First piece starting after `s` (the insertion point).
    let at = this.indexAt(s);
    if ((this.pieces[at]?.start ?? Infinity) <= s) at++;
    const prev = this.pieces[at - 1];
    if (prev && prev.start + prev.bytes.length > s) {
      const skip = prev.start + prev.bytes.length - s;
      if (skip >= b.length) return;
      s += skip;
      b = b.subarray(skip);
    }
    // Pieces starting right where the new bytes now start are skipped too.
    for (let p = this.pieces[at]; p && p.start <= s; p = this.pieces[at]) {
      const skip = p.start + p.bytes.length - s;
      if (skip >= b.length) return;
      s += skip;
      b = b.subarray(skip);
      at++;
    }
    const next = this.pieces[at];
    if (next && s + b.length > next.start) b = b.subarray(0, next.start - s);
    // A trimmed piece is copied: a view would keep the whole network chunk alive.
    if (b.length !== bytes.length) b = b.slice();
    this.pieces.splice(at, 0, { start: s, bytes: b });
    this.stored += b.length;
  }

  /** Index of the last piece starting at or before `offset` (0 when none). */
  private indexAt(offset: number): number {
    let lo = 0;
    let hi = this.pieces.length - 1;
    let found = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((this.pieces[mid]?.start ?? 0) <= offset) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  }

  /** Contiguous bytes from `offset` (at most `max`), or null when not present. */
  readAt(offset: number, max: number): Uint8Array | null {
    const p = this.pieces[this.indexAt(offset)];
    if (!p || p.start > offset || p.start + p.bytes.length <= offset) return null;
    const from = offset - p.start;
    return p.bytes.subarray(from, Math.min(p.bytes.length, from + max));
  }

  has(offset: number): boolean {
    return this.readAt(offset, 1) !== null;
  }

  /** First offset ≥ `from` that is not stored (the size when everything after is). */
  nextMissing(from: number): number {
    let pos = from;
    for (let i = this.indexAt(from); i < this.pieces.length; i++) {
      const p = this.pieces[i];
      if (!p) continue;
      if (p.start > pos) break;
      pos = Math.max(pos, p.start + p.bytes.length);
    }
    return pos;
  }

  /** First stored offset > `from`, or null. */
  nextStored(from: number): number | null {
    for (const p of this.pieces) if (p.start > from) return p.start;
    return null;
  }

  get complete(): boolean {
    return this.size !== null && this.nextMissing(0) >= this.size;
  }

  /**
   * Keeps only the pieces that overlap one of `ranges` (`[start, end)` byte ranges; a window file
   * read at several places, SPEC §24.5).
   */
  retain(ranges: readonly { start: number; end: number }[]): void {
    const kept = this.pieces.filter((p) =>
      ranges.some((r) => p.start < r.end && p.start + p.bytes.length > r.start),
    );
    if (kept.length === this.pieces.length) return;
    this.pieces = kept;
    this.stored = kept.reduce((n, p) => n + p.bytes.length, 0);
  }

  clear(): void {
    this.pieces = [];
    this.stored = 0;
  }
}

export type FetchLike = (
  url: string,
  init: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}>;

/** Retries of a failed request: `baseMs × 2^n` apart, at most `attempts` in a row. */
export interface RetryPolicy {
  baseMs: number;
  attempts: number;
}

export const DEFAULT_RETRY: RetryPolicy = { baseMs: 500, attempts: 5 };

/** A non-2xx response; 4xx are final, 5xx are retried. */
export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/** A seek waits for the running download only when it is this close (else a Range request). */
const LOOKAHEAD = 64 * 1024;
/** Range request size in `window` mode. */
export const WINDOW_BLOCK = 2 * 1024 * 1024;

/**
 * One fetch at a time per file. `whole` mode (Opus) streams the file progressively and then fills
 * gaps left by seeks; `window` mode (FLAC, and Opus versions over 20 min) reads 2 MB Range blocks
 * on demand. A `whole` file
 * larger than `wholeLimit` (a long recording) switches to `window` once its size is known, so the
 * current song's compressed bytes stay within the cache budget (SPEC §6.4). Network errors and
 * HTTP 5xx are retried with backoff; a 4xx or too many failures in a row are final (`error`) until
 * `retry()`.
 */
export class FileFetcher {
  private active: { pos: number; end: number; abort: AbortController } | null = null;
  private failed: Error | null = null;
  private stopped = false;
  /** Failures since the last bytes arrived. */
  private attempts = 0;
  /** Pending retry and the offset it will request. */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAt = 0;
  private _mode: "whole" | "window";
  /** Largest file kept whole in `whole` mode (bytes); bigger ones are read in windows. */
  wholeLimit = Infinity;

  constructor(
    private readonly url: string,
    readonly file: SparseFile,
    mode: "whole" | "window",
    private readonly fetchImpl: FetchLike,
    private readonly onData: () => void,
    private readonly retryPolicy: RetryPolicy = DEFAULT_RETRY,
  ) {
    this._mode = mode;
  }

  get mode(): "whole" | "window" {
    return this._mode;
  }

  /** Switches a `whole` file that turned out too big to `window` mode. */
  private applyLimit(): void {
    if (this._mode === "whole" && this.file.size !== null && this.file.size > this.wholeLimit) {
      this._mode = "window";
      const a = this.active;
      if (a) a.end = Math.min(a.end, a.pos + WINDOW_BLOCK);
    }
  }

  /** The final error (no more retries until `retry()`), or null. */
  get error(): Error | null {
    return this.failed;
  }

  /** Makes sure bytes at `offset` are present or on their way. */
  want(offset: number): void {
    if (this.stopped || this.failed || this.file.has(offset)) return;
    if (this.file.size !== null && offset >= this.file.size) return;
    if (this.retryTimer) {
      this.retryAt = offset; // the retry after the backoff requests this instead
      return;
    }
    const a = this.active;
    if (a && a.pos <= offset && offset < (a.end === Infinity ? a.pos + LOOKAHEAD : a.end)) return;
    this.start(offset);
  }

  /** Starts the progressive download from the beginning (Opus). */
  begin(): void {
    this.applyLimit();
    if (this._mode === "whole" && !this.active && !this.file.complete)
      this.want(this.file.nextMissing(0));
  }

  /** Allows downloads again after `stop()` (the song is loaded again). */
  resume(): void {
    this.stopped = false;
  }

  /** Clears a final error so the next `want()` tries again (a seek or a new start). */
  retry(): void {
    this.failed = null;
    this.attempts = 0;
  }

  stop(): void {
    this.stopped = true;
    this.active?.abort.abort();
    this.active = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private start(offset: number) {
    this.active?.abort.abort();
    const next = this.file.nextStored(offset);
    let end = next ?? Infinity; // exclusive
    if (this._mode === "window") end = Math.min(end, offset + WINDOW_BLOCK);
    if (this.file.size !== null) end = Math.min(end, this.file.size);
    const abort = new AbortController();
    const job = { pos: offset, end, abort };
    this.active = job;
    void this.run(job).catch((err: unknown) => {
      if (abort.signal.aborted) return;
      if (this.active === job) this.active = null;
      this.fail(err instanceof Error ? err : new Error(String(err)), job.pos);
    });
  }

  private fail(err: Error, pos: number) {
    const final = err instanceof HttpError && err.status < 500;
    if (!final && !this.stopped && this.attempts < this.retryPolicy.attempts) {
      const delay = this.retryPolicy.baseMs * 2 ** this.attempts;
      this.attempts++;
      this.retryAt = pos;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.want(this.retryAt);
        this.begin();
      }, delay);
      return;
    }
    this.failed = err;
    this.onData(); // lets the reader see the error
  }

  private async run(job: { pos: number; end: number; abort: AbortController }) {
    const range = job.end === Infinity ? `bytes=${job.pos}-` : `bytes=${job.pos}-${job.end - 1}`;
    const res = await this.fetchImpl(this.url, {
      headers: job.pos === 0 && job.end === Infinity ? {} : { Range: range },
      signal: job.abort.signal,
    });
    if (res.status !== 200 && res.status !== 206) throw new HttpError(res.status);
    if (res.status === 200) job.pos = 0; // server ignored the range
    const total = res.headers.get("content-range")?.split("/")[1];
    if (total && total !== "*") this.file.size = Number(total);
    else if (res.status === 200) {
      const len = res.headers.get("content-length");
      if (len) this.file.size = Number(len);
    }
    this.applyLimit(); // bounds this job too when the file is too big to keep whole
    if (!res.body) throw new Error("No response body");
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      this.file.add(job.pos, value);
      job.pos += value.length;
      this.attempts = 0;
      this.onData();
      if (job.pos >= job.end) {
        job.abort.abort(); // reached data we already have
        break;
      }
    }
    if (this.active === job) this.active = null;
    if (this.file.size === null && job.end === Infinity) this.file.size = job.pos;
    this.onData();
    if (this._mode === "whole" && !this.stopped && !this.file.complete) {
      this.want(this.file.nextMissing(0));
    }
  }
}
