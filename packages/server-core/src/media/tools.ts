import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export interface ToolPaths {
  ffmpeg: string;
  ffprobe: string;
  /** poppler-utils (SPEC §5.7): PDF first-page thumbnails and page counts. */
  pdftoppm: string;
  pdfinfo: string;
}

export const DEFAULT_TOOLS: ToolPaths = {
  ffmpeg: process.env.FFMPEG_PATH ?? "ffmpeg",
  ffprobe: process.env.FFPROBE_PATH ?? "ffprobe",
  pdftoppm: process.env.PDFTOPPM_PATH ?? "pdftoppm",
  pdfinfo: process.env.PDFINFO_PATH ?? "pdfinfo",
};

export class ToolError extends Error {
  constructor(
    message: string,
    readonly stderrTail: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

/** A media tool ran past its job's time limit (see {@link mediaTimeLimitMs}). */
export class ToolTimeoutError extends ToolError {
  constructor(cmd: string, stderrTail: string) {
    super(`${cmd} timed out`, stderrTail);
    this.name = "ToolTimeoutError";
  }
}

/** Limit for steps that run before the duration is known (probe, dual-mono check). */
export const PROBE_TIME_LIMIT_MS = 5 * 60_000;
/** No media job may keep the single worker busy longer than this (SPEC §5.3). */
export const MAX_MEDIA_TIME_LIMIT_MS = 3 * 60 * 60_000;

/**
 * Wall-clock budget for all media tool runs of one job on `durationSec` of audio: 10× real time
 * plus 5 minutes, capped at {@link MAX_MEDIA_TIME_LIMIT_MS}. A hung ffmpeg otherwise blocks the
 * worker forever, because the job's heartbeat keeps renewing its lease.
 */
export function mediaTimeLimitMs(durationSec: number): number {
  const sec = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  return Math.min(Math.ceil(sec * 10_000) + 5 * 60_000, MAX_MEDIA_TIME_LIMIT_MS);
}

/** `signal`, additionally aborted after `ms` with a TimeoutError (which runTool reports). */
export function withTimeLimit(signal: AbortSignal, ms: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}

function timedOut(signal: AbortSignal | undefined): boolean {
  return (
    signal?.aborted === true &&
    (signal.reason as { name?: string } | undefined)?.name === "TimeoutError"
  );
}

export interface RunOptions {
  signal?: AbortSignal;
  /** Collect stdout into a string (only for small outputs, e.g. ffprobe JSON). */
  captureStdout?: boolean;
  /** Pipe stdout here instead (streaming, e.g. PCM for peaks or WAV downloads). */
  stdout?: Writable | ((stream: Readable) => Promise<void>);
  onStderrLine?: (line: string) => void;
  /** Lower CPU priority so the API stays responsive (SPEC §5.3). Default true. */
  nice?: boolean;
}

const STDERR_TAIL = 8 * 1024;

/**
 * Runs a media tool as a child process. Output is streamed, never buffered whole (SPEC §19.6);
 * only a bounded stderr tail is kept for error messages.
 */
export function runTool(
  cmd: string,
  args: string[],
  opts: RunOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const useNice = opts.nice !== false && process.platform !== "win32";
  const [bin, argv] = useNice ? ["nice", ["-n", "10", cmd, ...args]] : [cmd, args];
  return new Promise((resolve, reject) => {
    const child = spawn(bin, argv, { stdio: ["ignore", "pipe", "pipe"], signal: opts.signal });
    let stdout = "";
    let stderr = "";
    let lineBuf = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL);
      if (opts.onStderrLine) {
        lineBuf += chunk;
        const lines = lineBuf.split(/\r?\n|\r/);
        lineBuf = lines.pop() ?? "";
        for (const l of lines) opts.onStderrLine(l);
      }
    });
    let stdoutDone: Promise<void> = Promise.resolve();
    if (opts.captureStdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (c: string) => (stdout += c));
    } else if (typeof opts.stdout === "function") {
      stdoutDone = opts.stdout(child.stdout);
    } else if (opts.stdout) {
      child.stdout.pipe(opts.stdout);
    } else {
      child.stdout.resume();
    }
    child.on("error", (err) => {
      reject(timedOut(opts.signal) ? new ToolTimeoutError(cmd, stderr) : err);
    });
    child.on("close", (code) => {
      if (opts.onStderrLine && lineBuf) opts.onStderrLine(lineBuf);
      stdoutDone.then(
        () => {
          if (code === 0) resolve({ stdout, stderr });
          else {
            const last = stderr.trim().split("\n").slice(-3).join(" | ").slice(-400);
            reject(new ToolError(`${cmd} exited with code ${String(code)}: ${last}`, stderr));
          }
        },
        (err: unknown) => {
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  });
}

/** Common ffmpeg prefix: quiet, no stdin, single thread (SPEC §5.3). */
export function ffmpegArgs(...rest: string[]): string[] {
  return ["-hide_banner", "-nostdin", "-y", "-threads", "1", ...rest];
}
