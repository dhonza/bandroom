import fs from "node:fs";
import path from "node:path";

/** At this size the log file is renamed to `.1` (the previous `.1` is dropped), SPEC §29.7. */
export const LOG_FILE_MAX_BYTES = 5 * 1024 * 1024;
/** The reader looks at most at this many trailing bytes of each file. */
export const LOG_READ_MAX_BYTES = 1024 * 1024;

export const LOG_SOURCES = ["app", "worker"] as const;
export type LogSource = (typeof LOG_SOURCES)[number];

/** `DATA_DIR/logs/<source>.log`. */
export function logFilePath(dataDir: string, source: LogSource): string {
  return path.join(dataDir, "logs", `${source}.log`);
}

/**
 * An append-only, size-capped log file for pino's multistream. Writes are synchronous: only
 * warn+ records come here, so they are rare, and a crash must not lose them. Errors writing the
 * file never break logging to stdout.
 */
export class CappedLogFile {
  private fd: number | null = null;
  private size = 0;

  constructor(
    readonly file: string,
    private readonly maxBytes: number = LOG_FILE_MAX_BYTES,
  ) {}

  private open(): number {
    if (this.fd !== null) return this.fd;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.fd = fs.openSync(this.file, "a", 0o640);
    this.size = fs.fstatSync(this.fd).size;
    return this.fd;
  }

  private rotate(): void {
    if (this.fd !== null) fs.closeSync(this.fd);
    this.fd = null;
    fs.rmSync(`${this.file}.1`, { force: true });
    fs.renameSync(this.file, `${this.file}.1`);
  }

  write(chunk: string): void {
    try {
      const fd = this.open();
      const bytes = Buffer.byteLength(chunk);
      fs.writeSync(fd, chunk);
      this.size += bytes;
      if (this.size >= this.maxBytes) this.rotate();
    } catch {
      // The data disk may be full or read-only; stdout still has the record.
    }
  }

  close(): void {
    if (this.fd !== null) fs.closeSync(this.fd);
    this.fd = null;
  }
}

/** The last `maxBytes` of a file as text, without its first (partial) line; "" if missing. */
function readTail(file: string, maxBytes: number): string {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return "";
  }
  try {
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

export interface LogRecord {
  time: number;
  level: number;
  msg: string;
  /** The whole record (redacted when it was written). */
  raw: Record<string, unknown>;
}

/**
 * The newest records of the rotated and the current file, oldest first, filtered by minimum level
 * and time. Bounded: reads at most {@link LOG_READ_MAX_BYTES} of each file.
 */
export function readLogRecords(
  file: string,
  opts: { minLevel?: number; since?: number; limit?: number; maxBytes?: number } = {},
): LogRecord[] {
  const maxBytes = opts.maxBytes ?? LOG_READ_MAX_BYTES;
  const text = readTail(`${file}.1`, maxBytes) + readTail(file, maxBytes);
  const out: LogRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const time = typeof r.time === "number" ? r.time : 0;
    const level = typeof r.level === "number" ? r.level : 0;
    if (opts.minLevel !== undefined && level < opts.minLevel) continue;
    if (opts.since !== undefined && time < opts.since) continue;
    out.push({ time, level, msg: typeof r.msg === "string" ? r.msg : "", raw: r });
  }
  const limit = opts.limit ?? 200;
  return out.slice(-limit);
}
