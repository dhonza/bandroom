import type { z } from "zod";
import type { Db } from "../db/connection";
import type { ToolPaths } from "../media/tools";
import type { StorageBackend } from "../storage/backend";

/** Something the API should fan out over SSE (filtered per connection by permissions). */
export interface JobEvent {
  type: string;
  projectId?: string | null;
  songId?: string | null;
  /** User-targeted events (`notification`) reach only this user. */
  userId?: string | null;
  data: Record<string, unknown>;
}

/**
 * Execution context of a job (SPEC §18.4). The local worker implements it with direct DB and
 * storage access; remote workers (M15) will implement the same interface over HTTP.
 */
export interface JobContext {
  readonly jobId: string;
  readonly db: Db;
  readonly storage: StorageBackend;
  readonly tools: ToolPaths;
  /** Per-job scratch directory, removed after the job. */
  readonly tmpDir: string;
  readonly signal: AbortSignal;
  /** Local path of an existing variant. */
  input(ref: { assetId: string; variant: string }): Promise<string>;
  /** Stores a file as a blob and attaches it as a variant (the file is moved). */
  output(
    ref: { assetId: string; variant: string },
    filePath: string,
    meta?: Record<string, unknown>,
  ): Promise<string>;
  progress(fraction: number, note?: string): void;
  log(msg: string): void;
  emit(event: JobEvent): void;
}

export interface JobHandler<P = unknown, R = unknown> {
  readonly type: string;
  readonly capability: string;
  readonly payloadSchema: z.ZodType<P>;
  run(ctx: JobContext, payload: P): Promise<R>;
}

/** Thrown for failures that retrying cannot fix (unsupported file, corrupt data). */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}
