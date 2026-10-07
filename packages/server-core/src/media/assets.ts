import { UploadOptionsSchema, uuidv7, type UploadOptions } from "@bandroom/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../db/connection";
import { assets } from "../db/schema";
import { ProbeSchema, type Probe } from "./probe";
import { putVariant } from "./variants";

export type AssetRow = typeof assets.$inferSelect;
export type AssetKind = AssetRow["kind"];
export type AssetStatus = AssetRow["status"];

export interface NewAsset {
  kind: AssetKind;
  originalFilename: string;
  mimeType?: string;
  sizeBytes: number;
  originalHash: string;
  uploadedBy: string | null;
  /** Upload options (SPEC §28.2); kept on the asset so retries and bounces keep them. */
  ingestOptions?: UploadOptions | null;
}

export function createAsset(db: Db, input: NewAsset, now: number = Date.now()): AssetRow {
  return db
    .insert(assets)
    .values({
      id: uuidv7(now),
      kind: input.kind,
      originalFilename: input.originalFilename.slice(0, 255),
      mimeType: input.mimeType ?? "application/octet-stream",
      sizeBytes: input.sizeBytes,
      originalHash: input.originalHash,
      status: "queued",
      uploadedBy: input.uploadedBy,
      ingestOptions: input.ingestOptions ? JSON.stringify(input.ingestOptions) : null,
      createdAt: now,
    })
    .returning()
    .get();
}

/**
 * An asset whose `original` variant is an already stored blob (uploads, imports, edited text,
 * MIDI files). `now` defaults per call, as in `createAsset` and `putVariant`.
 */
export function createOriginalAsset(
  db: Db,
  input: NewAsset,
  blob: { hash: string; sizeBytes: number },
  now?: number,
): AssetRow {
  const asset = createAsset(db, input, now);
  putVariant(db, asset.id, "original", blob.hash, { size: blob.sizeBytes }, now);
  return asset;
}

export function getAsset(db: Db, id: string): AssetRow | undefined {
  return db.select().from(assets).where(eq(assets.id, id)).get();
}

export function setAssetStatus(
  db: Db,
  id: string,
  status: AssetStatus,
  error: string | null = null,
): void {
  db.update(assets).set({ status, error }).where(eq(assets.id, id)).run();
}

export function setAssetProbe(db: Db, id: string, probe: Probe): void {
  db.update(assets)
    .set({ probe: JSON.stringify(probe) })
    .where(eq(assets.id, id))
    .run();
}

/** The asset's upload options (SPEC §28.2); defaults (keep full quality, standard) if unset. */
export function assetIngestOptions(a: Pick<AssetRow, "ingestOptions">): UploadOptions {
  let raw: unknown;
  try {
    raw = a.ingestOptions ? JSON.parse(a.ingestOptions) : {};
  } catch {
    raw = {};
  }
  const r = UploadOptionsSchema.safeParse(raw);
  return r.success ? r.data : UploadOptionsSchema.parse({});
}

export function assetProbe(a: AssetRow): Probe | null {
  if (!a.probe) return null;
  const r = ProbeSchema.safeParse(JSON.parse(a.probe));
  return r.success ? r.data : null;
}
