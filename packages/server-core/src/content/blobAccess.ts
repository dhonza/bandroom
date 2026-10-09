import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/connection";
import { assetVariants, projects, tracks, trackVersions } from "../db/schema";
import { documentReferrersOfAsset } from "./documents";
import { visibleVersion } from "./visibleVersions";

/**
 * Track-version variants that carry the lossless audio (or rebuild it): fetchable only with
 * download rights (SPEC §3.4, DECISIONS 2026-10-01). Opus, peaks and the Opus seek indexes are
 * "stream".
 */
export const DOWNLOAD_ONLY_VARIANTS: ReadonlySet<string> = new Set([
  "original",
  "flac",
  "seekindex_flac",
  "wavmeta",
  "wavpack",
]);

export type BlobReferrer =
  /** A variant of a track version's audio asset. */
  | { kind: "song"; songId: string; variant: string }
  | { kind: "project"; projectId: string; variant: string }
  /** A project-level document: needs at least `viewer` on the project (SPEC §3.3). */
  | { kind: "projectDocument"; projectId: string; variant: string };

/**
 * Who references a blob (SPEC §18.3 blob access): blob → variants → assets → track versions or
 * document versions → songs, project-level documents, or project images. Access is granted if the user can stream/view at least one referrer.
 */
export function blobReferrers(db: Db, hash: string): BlobReferrer[] {
  const out: BlobReferrer[] = [];
  const variants = db
    .select({ assetId: assetVariants.assetId, variant: assetVariants.variant })
    .from(assetVariants)
    .where(eq(assetVariants.blobHash, hash))
    .all();
  for (const v of variants) {
    for (const r of db
      .select({ songId: tracks.songId })
      .from(trackVersions)
      .innerJoin(tracks, eq(tracks.id, trackVersions.trackId))
      .where(and(eq(trackVersions.assetId, v.assetId), visibleVersion(), isNull(tracks.deletedAt)))
      .all()) {
      out.push({ kind: "song", songId: r.songId, variant: v.variant });
    }
    for (const p of db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.imageAssetId, v.assetId), isNull(projects.deletedAt)))
      .all()) {
      out.push({ kind: "project", projectId: p.id, variant: v.variant });
    }
    for (const d of documentReferrersOfAsset(db, v.assetId)) {
      out.push({ kind: "projectDocument", projectId: d.projectId, variant: v.variant });
    }
  }
  return out;
}
