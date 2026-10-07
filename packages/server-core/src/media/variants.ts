import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/connection";
import { assets, assetVariants, blobs, userUsage } from "../db/schema";
import { addBlobRef, releaseBlobRef } from "../storage/blobs";

export type AssetVariantRow = typeof assetVariants.$inferSelect;
export const SYSTEM_USAGE_ID = "system";

/** Adds bytes to an uploader's usage (SPEC §15.1); `null` uploader counts as "system". */
export function adjustUsage(
  db: Db,
  userId: string | null,
  delta: number,
  now: number = Date.now(),
): void {
  if (delta === 0) return;
  db.insert(userUsage)
    .values({ userId: userId ?? SYSTEM_USAGE_ID, bytes: Math.max(0, delta), updatedAt: now })
    .onConflictDoUpdate({
      target: userUsage.userId,
      set: { bytes: sql`MAX(${userUsage.bytes} + ${delta}, 0)`, updatedAt: now },
    })
    .run();
}

export function getUsage(db: Db, userId: string): number {
  return (
    db.select({ bytes: userUsage.bytes }).from(userUsage).where(eq(userUsage.userId, userId)).get()
      ?.bytes ?? 0
  );
}

function blobSize(db: Db, hash: string): number {
  return db.select({ s: blobs.sizeBytes }).from(blobs).where(eq(blobs.hash, hash)).get()?.s ?? 0;
}

function uploaderOf(db: Db, assetId: string): string | null {
  return (
    db.select({ u: assets.uploadedBy }).from(assets).where(eq(assets.id, assetId)).get()?.u ?? null
  );
}

/**
 * Attaches (or replaces) a variant of an asset: maintains blob reference counts and the uploader's
 * usage. Dedupe does not reduce individual usage (SPEC §15.1).
 */
export function putVariant(
  db: Db,
  assetId: string,
  variant: string,
  blobHash: string,
  meta: Record<string, unknown> = {},
  now: number = Date.now(),
): void {
  db.transaction(() => {
    const uploader = uploaderOf(db, assetId);
    const old = getVariant(db, assetId, variant);
    if (old) {
      if (old.blobHash === blobHash) {
        db.update(assetVariants)
          .set({ meta: JSON.stringify(meta) })
          .where(and(eq(assetVariants.assetId, assetId), eq(assetVariants.variant, variant)))
          .run();
        return;
      }
      removeVariant(db, assetId, variant, now);
    }
    db.insert(assetVariants)
      .values({ assetId, variant, blobHash, meta: JSON.stringify(meta), createdAt: now })
      .run();
    addBlobRef(db, blobHash);
    adjustUsage(db, uploader, blobSize(db, blobHash), now);
  });
}

export function removeVariant(
  db: Db,
  assetId: string,
  variant: string,
  now: number = Date.now(),
): boolean {
  const old = getVariant(db, assetId, variant);
  if (!old) return false;
  db.delete(assetVariants)
    .where(and(eq(assetVariants.assetId, assetId), eq(assetVariants.variant, variant)))
    .run();
  releaseBlobRef(db, old.blobHash, now);
  adjustUsage(db, uploaderOf(db, assetId), -blobSize(db, old.blobHash), now);
  return true;
}

export function getVariant(db: Db, assetId: string, variant: string): AssetVariantRow | undefined {
  return db
    .select()
    .from(assetVariants)
    .where(and(eq(assetVariants.assetId, assetId), eq(assetVariants.variant, variant)))
    .get();
}

export function listVariants(db: Db, assetId: string): AssetVariantRow[] {
  return db.select().from(assetVariants).where(eq(assetVariants.assetId, assetId)).all();
}

/** Removes all variants (e.g. asset deleted); blobs become GC candidates. */
export function removeAllVariants(db: Db, assetId: string, now: number = Date.now()): void {
  for (const v of listVariants(db, assetId)) removeVariant(db, assetId, v.variant, now);
}
