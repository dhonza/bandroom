import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import type { ByteRange, StorageBackend } from "./backend";

/** Blobs live at `<root>/ab/cd/<hash>` (SPEC §5.4). */
export function localStorageKey(hash: string): string {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`Invalid blob hash: ${hash}`);
  return `${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
}

export class LocalStorage implements StorageBackend {
  readonly name = "local" as const;

  constructor(private readonly root: string) {}

  private abs(key: string): string {
    const p = path.resolve(this.root, key);
    if (!p.startsWith(path.resolve(this.root) + path.sep))
      throw new Error("Storage key escapes root");
    return p;
  }

  async putFile(filePath: string, hash: string): Promise<{ size: number; storageKey: string }> {
    const key = localStorageKey(hash);
    const dest = this.abs(key);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const existing = await this.head(key);
    if (existing) {
      // Identical content already stored (dedupe): drop the incoming copy.
      await fs.rm(filePath, { force: true });
      return { size: existing.size, storageKey: key };
    }
    // Write next to the destination, then atomically rename (same filesystem).
    const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
    try {
      await fs.rename(filePath, tmp);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      await fs.copyFile(filePath, tmp);
      await fs.rm(filePath, { force: true });
    }
    await fs.rename(tmp, dest);
    const { size } = await fs.stat(dest);
    return { size, storageKey: key };
  }

  getStream(storageKey: string, range?: ByteRange): Readable {
    return createReadStream(
      this.abs(storageKey),
      range ? { start: range.start, end: range.end } : {},
    );
  }

  localPath(storageKey: string): Promise<string> {
    return Promise.resolve(this.abs(storageKey));
  }

  async head(storageKey: string): Promise<{ size: number } | null> {
    try {
      const s = await fs.stat(this.abs(storageKey));
      return { size: s.size };
    } catch {
      return null;
    }
  }

  async delete(storageKey: string): Promise<void> {
    await fs.rm(this.abs(storageKey), { force: true });
  }
}
