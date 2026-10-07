import type { Readable } from "node:stream";

export interface ByteRange {
  /** Inclusive start offset. */
  start: number;
  /** Inclusive end offset. */
  end: number;
}

/**
 * Storage backend for content-addressed blobs (SPEC §5.4). The local backend is the default;
 * S3 arrives in M15. Implementations never modify a blob after `put`.
 */
export interface StorageBackend {
  readonly name: "local" | "s3";
  /** Moves/copies a finished local file into storage under its hash. */
  putFile(filePath: string, hash: string): Promise<{ size: number; storageKey: string }>;
  getStream(storageKey: string, range?: ByteRange): Readable;
  /** Local path for tools like ffmpeg; remote backends download to a temp file first. */
  localPath(storageKey: string): Promise<string>;
  head(storageKey: string): Promise<{ size: number } | null>;
  delete(storageKey: string): Promise<void>;
}
