import { setTimeout as sleep } from "node:timers/promises";
import { and, eq, gte, inArray, or, sql } from "drizzle-orm";
import type { Db } from "../db/connection";
import { blobs } from "../db/schema";
import type { StorageBackend } from "./backend";
import { sha256File } from "./hash";

export type BlobRow = typeof blobs.$inferSelect;
export const BLOB_GC_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * `refCount` of a blob the garbage collector has claimed: its file is being deleted, and the row
 * goes once that is done. Nothing may reference or reuse it meanwhile.
 */
const GC_CLAIMED = -1;
const CLAIM_WAIT_MS = 50;
const CLAIM_WAIT_MAX_MS = 30_000;

/**
 * Keeps an existing, unreferenced blob from being collected while a caller reuses it: restarts
 * its grace period. Waits while the collector is deleting it, so the caller then stores the file
 * again instead of relying on one that is about to disappear.
 */
async function protectFromGc(db: Db, hash: string, now: number): Promise<void> {
  const until = Date.now() + CLAIM_WAIT_MAX_MS;
  for (;;) {
    db.update(blobs)
      .set({ unreferencedAt: now })
      .where(and(eq(blobs.hash, hash), eq(blobs.refCount, 0)))
      .run();
    if (getBlob(db, hash)?.refCount !== GC_CLAIMED) return;
    if (Date.now() > until) throw new Error(`Blob ${hash} is being garbage-collected`);
    await sleep(CLAIM_WAIT_MS);
  }
}

/**
 * Stores a finished local file as a blob and returns its hash. Identical content is stored once
 * (the file is removed in that case). The new blob starts with refCount 0: callers attach it to a
 * variant with {@link addBlobRef} in the same logical step. Safe against a concurrent
 * {@link collectGarbageBlobs} in another process (review M12).
 */
export async function storeFile(
  db: Db,
  storage: StorageBackend,
  filePath: string,
  knownHash?: string,
  now: number = Date.now(),
): Promise<BlobRow> {
  const hash = knownHash ?? (await sha256File(filePath));
  // Before putFile: its dedupe drops our copy when the file exists, so that file must stay.
  await protectFromGc(db, hash, now);
  const { size, storageKey } = await storage.putFile(filePath, hash);
  db.insert(blobs)
    .values({
      hash,
      sizeBytes: size,
      backend: storage.name,
      storageKey,
      refCount: 0,
      createdAt: now,
      unreferencedAt: now,
    })
    .onConflictDoUpdate({
      target: blobs.hash,
      // An unreferenced blob gets a fresh grace period: the caller is about to reference it.
      set: {
        unreferencedAt: sql`CASE WHEN ${blobs.refCount} = 0 THEN ${now} ELSE ${blobs.unreferencedAt} END`,
      },
    })
    .run();
  const row = getBlob(db, hash);
  if (!row) throw new Error(`Blob ${hash} missing after insert`);
  return row;
}

export function getBlob(db: Db, hash: string): BlobRow | undefined {
  return db.select().from(blobs).where(eq(blobs.hash, hash)).get();
}

export function addBlobRef(db: Db, hash: string): void {
  const changed = db
    .update(blobs)
    .set({ refCount: sql`${blobs.refCount} + 1`, unreferencedAt: null })
    .where(and(eq(blobs.hash, hash), gte(blobs.refCount, 0)))
    .run().changes;
  if (changed === 0) throw new Error(`Blob ${hash} is missing or being garbage-collected`);
}

export function releaseBlobRef(db: Db, hash: string, now: number = Date.now()): void {
  db.update(blobs)
    .set({
      refCount: sql`MAX(${blobs.refCount} - 1, 0)`,
      unreferencedAt: sql`CASE WHEN ${blobs.refCount} <= 1 THEN ${now} ELSE ${blobs.unreferencedAt} END`,
    })
    .where(and(eq(blobs.hash, hash), gte(blobs.refCount, 0)))
    .run();
}

/** Hashes per query when the GC is limited to a list (SQLite's bound parameter limit). */
const HASH_CHUNK = 500;

/**
 * Deletes blobs unreferenced for longer than the grace period (daily `blob.gc`; after an explicit
 * purge only the purged hashes, with a short grace, SPEC §26.3). Each blob is first claimed in
 * the database, then its file is deleted, then its row; {@link storeFile} in another process
 * waits for a claimed blob instead of deduplicating against its file. Claims left by a crash are
 * finished on the next run.
 */
export async function collectGarbageBlobs(
  db: Db,
  storage: StorageBackend,
  now: number = Date.now(),
  opts: { graceMs?: number; hashes?: readonly string[] } = {},
): Promise<{ deleted: number; bytes: number }> {
  const cutoff = now - (opts.graceMs ?? BLOB_GC_GRACE_MS);
  const collectable = (hash?: string) =>
    and(
      hash === undefined ? undefined : eq(blobs.hash, hash),
      or(
        // `<=` so a zero grace (tests) collects a blob released in the same millisecond.
        and(eq(blobs.refCount, 0), sql`${blobs.unreferencedAt} <= ${cutoff}`),
        eq(blobs.refCount, GC_CLAIMED),
      ),
    );
  const candidates: BlobRow[] = [];
  if (opts.hashes === undefined)
    candidates.push(...db.select().from(blobs).where(collectable()).all());
  else
    for (let i = 0; i < opts.hashes.length; i += HASH_CHUNK) {
      const chunk = opts.hashes.slice(i, i + HASH_CHUNK);
      candidates.push(
        ...db
          .select()
          .from(blobs)
          .where(and(inArray(blobs.hash, chunk), collectable()))
          .all(),
      );
    }
  let bytes = 0;
  let deleted = 0;
  for (const b of candidates) {
    // The claim re-checks the conditions, so a blob referenced or reused meanwhile is kept.
    const claimed = db
      .update(blobs)
      .set({ refCount: GC_CLAIMED })
      .where(collectable(b.hash))
      .run().changes;
    if (claimed === 0) continue;
    await storage.delete(b.storageKey);
    db.delete(blobs)
      .where(and(eq(blobs.hash, b.hash), eq(blobs.refCount, GC_CLAIMED)))
      .run();
    bytes += b.sizeBytes;
    deleted++;
  }
  return { deleted, bytes };
}
