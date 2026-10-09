import {
  type ArchivedReason,
  type AudioQuality,
  LOSSLESS_PREVIEW_LIST_MAX,
  LOSSLESS_VARIANTS,
  qualityForKbps,
  songLossyOf,
  type LosslessVariant,
  type LosslessVersionRef,
  type RemoveLosslessPreview,
  type SongLossy,
  type TrashKind,
} from "@bandroom/shared";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/connection";
import { assets, assetVariants, blobs, songs, tracks, trackVersions } from "../db/schema";
import { assetProbe, type AssetRow } from "../media/assets";
import { opusKbpsFor, standardOpusKbps } from "../media/opusRates";
import { removeVariant } from "../media/variants";
import type { TrackRow, TrackVersionRow } from "./tracks";
import { visibleVersion } from "./visibleVersions";

// Remove full quality (SPEC §26.4): drop the flac, original, wavmeta and wavpack variants of
// versions, keep Opus and peaks, and mark the versions archived.

const LOSSLESS: readonly string[] = LOSSLESS_VARIANTS;
/** Removed along: the FLAC's seek index is useless without the FLAC. */
const REMOVED: readonly string[] = [...LOSSLESS_VARIANTS, "seekindex_flac"];

/** A version in a selection, with what the preview names it by. */
export interface LosslessTarget {
  version: TrackVersionRow;
  track: TrackRow;
  songTitle: string;
  projectId: string;
}

/**
 * The live versions an item stands for: a song → every version of its tracks, a track → its
 * versions, a version → itself. Items in the Trash are left out.
 */
function expandItem(db: Db, kind: TrashKind, id: string): LosslessTarget[] {
  return db
    .select({
      version: trackVersions,
      track: tracks,
      songTitle: songs.title,
      projectId: songs.projectId,
    })
    .from(trackVersions)
    .innerJoin(tracks, eq(tracks.id, trackVersions.trackId))
    .innerJoin(songs, eq(songs.id, tracks.songId))
    .where(
      and(
        kind === "song"
          ? eq(tracks.songId, id)
          : kind === "track"
            ? eq(tracks.id, id)
            : eq(trackVersions.id, id),
        visibleVersion(),
        isNull(tracks.deletedAt),
        isNull(songs.deletedAt),
      ),
    )
    .all();
}

/**
 * Whether the user uploaded every live version inside the item (the uploader rule of SPEC §26.4
 * applied to a song or track selection). Empty items count as owned: nothing would change.
 */
export function ownsAllVersions(db: Db, kind: TrashKind, id: string, userId: string): boolean {
  return expandItem(db, kind, id).every((e) => e.version.uploadedBy === userId);
}

export interface LosslessPlan {
  /** Versions whose full-quality files go. */
  targets: LosslessTarget[];
  /** Their assets, each once. */
  assetIds: string[];
  /**
   * Assets whose Opus is re-encoded at the chosen quality before their full quality goes (SPEC
   * §28.3), with the bitrate to encode; the rest lose it at once.
   */
  reencode: { assetId: string; kbps: number }[];
  preview: RemoveLosslessPreview;
}

const refOf = (t: LosslessTarget): LosslessVersionRef => ({
  id: t.version.id,
  number: t.version.number,
  trackName: t.track.name,
  songTitle: t.songTitle,
});

/**
 * Works out what removing the full quality of the items would do, without changing anything:
 * which versions qualify (ready, with a full-quality file left), the files and bytes, lossy
 * sources whose original goes, copies sharing the assets, and what is skipped (SPEC §26.4).
 */
export function planLosslessRemoval(
  db: Db,
  items: { kind: TrashKind; id: string }[],
  quality?: AudioQuality,
): LosslessPlan {
  const seen = new Set<string>();
  const targets: LosslessTarget[] = [];
  const skipped = { notReady: 0, alreadyLossy: 0 };
  const assetById = new Map<string, AssetRow>();
  const variantsByAsset = new Map<string, { variant: string; blobHash: string }[]>();
  const assetOf = (id: string) => {
    let a = assetById.get(id);
    if (!a) {
      a = db.select().from(assets).where(eq(assets.id, id)).get();
      if (a) assetById.set(id, a);
    }
    return a;
  };
  const losslessVariantsOf = (assetId: string) => {
    let v = variantsByAsset.get(assetId);
    if (!v) {
      v = db
        .select({ variant: assetVariants.variant, blobHash: assetVariants.blobHash })
        .from(assetVariants)
        .where(
          and(eq(assetVariants.assetId, assetId), inArray(assetVariants.variant, [...REMOVED])),
        )
        .all();
      variantsByAsset.set(assetId, v);
    }
    return v;
  };
  for (const item of items) {
    for (const e of expandItem(db, item.kind, item.id)) {
      if (seen.has(e.version.id)) continue;
      seen.add(e.version.id);
      const asset = assetOf(e.version.assetId);
      if (!asset || asset.status !== "ready") {
        skipped.notReady++;
        continue;
      }
      if (!losslessVariantsOf(asset.id).some((v) => LOSSLESS.includes(v.variant))) {
        skipped.alreadyLossy++;
        continue;
      }
      targets.push(e);
    }
  }

  const assetIds = [...new Set(targets.map((t) => t.version.assetId))];
  // SPEC §28.3: the current Opus of each asset, and whether the chosen quality needs a new one.
  const opusOf = new Map<string, { kbps: number; mono: boolean }>();
  if (assetIds.length > 0) {
    for (const v of db
      .select({ assetId: assetVariants.assetId, meta: assetVariants.meta })
      .from(assetVariants)
      .where(and(inArray(assetVariants.assetId, assetIds), eq(assetVariants.variant, "opus")))
      .all()) {
      const m = JSON.parse(v.meta) as { bitrate?: unknown; channels?: unknown };
      opusOf.set(v.assetId, {
        kbps: typeof m.bitrate === "number" ? m.bitrate : 0,
        mono: m.channels === 1,
      });
    }
  }
  const reencode: LosslessPlan["reencode"] = [];
  if (quality) {
    for (const assetId of assetIds) {
      const opus = opusOf.get(assetId);
      const kbps = opusKbpsFor(db, quality, opus?.mono ?? false);
      if (opus?.kbps !== kbps) reencode.push({ assetId, kbps });
    }
  }
  const reencodeIds = new Set(reencode.map((r) => r.assetId));
  // Grouped by bitrate and channels: the preset a bitrate belongs to depends on both.
  const standard = standardOpusKbps(db);
  const currentOpus = new Map<string, RemoveLosslessPreview["currentOpus"][number]>();
  for (const t of targets) {
    const opus = opusOf.get(t.version.assetId);
    if (!opus) continue;
    const key = `${opus.kbps}:${opus.mono ? 1 : 2}`;
    const entry = currentOpus.get(key);
    if (entry) entry.count++;
    else
      currentOpus.set(key, {
        kbps: opus.kbps,
        count: 1,
        channels: opus.mono ? 1 : 2,
        quality: qualityForKbps(opus.kbps, opus.mono, standard),
      });
  }
  const files: Record<LosslessVariant, number> = { flac: 0, original: 0, wavmeta: 0, wavpack: 0 };
  const removedRefs = new Map<string, number>();
  for (const assetId of assetIds) {
    for (const v of losslessVariantsOf(assetId)) {
      if (LOSSLESS.includes(v.variant)) files[v.variant as LosslessVariant]++;
      removedRefs.set(v.blobHash, (removedRefs.get(v.blobHash) ?? 0) + 1);
    }
  }
  let usageBytes = 0;
  let bytesFreed = 0;
  if (removedRefs.size > 0) {
    const blobRows = db
      .select({ hash: blobs.hash, size: blobs.sizeBytes, refCount: blobs.refCount })
      .from(blobs)
      .where(inArray(blobs.hash, [...removedRefs.keys()]))
      .all();
    for (const b of blobRows) {
      const refs = removedRefs.get(b.hash) ?? 0;
      // Usage counts every variant (dedupe does not reduce usage, SPEC §15.1); the disk only
      // gets the file back when nothing else references it.
      usageBytes += b.size * refs;
      if (b.refCount - refs <= 0) bytesFreed += b.size;
    }
  }

  const lossy = targets.filter((t) => {
    const asset = assetById.get(t.version.assetId);
    const probe = asset && assetProbe(asset);
    return probe !== null && probe !== undefined && !probe.lossless;
  });
  const targetIds = new Set(targets.map((t) => t.version.id));
  const sharedCopies =
    assetIds.length === 0
      ? 0
      : db
          .select({ id: trackVersions.id })
          .from(trackVersions)
          .where(and(inArray(trackVersions.assetId, assetIds), visibleVersion()))
          .all()
          .filter((r) => !targetIds.has(r.id)).length;

  return {
    targets,
    assetIds,
    reencode,
    preview: {
      versions: targets.length,
      files,
      usageBytes,
      bytesFreed,
      lossySources: {
        count: lossy.length,
        items: lossy.slice(0, LOSSLESS_PREVIEW_LIST_MAX).map(refOf),
      },
      sharedCopies,
      skipped,
      reencode: targets.filter((t) => reencodeIds.has(t.version.assetId)).length,
      currentOpus: [...currentOpus.values()].sort(
        (a, b) => b.count - a.count || b.kbps - a.kbps || b.channels - a.channels,
      ),
    },
  };
}

/** The part of a plan that is removed at once: the assets that need no re-encode (SPEC §28.3). */
export function immediatePart(plan: LosslessPlan): LosslessPlan {
  if (plan.reencode.length === 0) return plan;
  const later = new Set(plan.reencode.map((r) => r.assetId));
  return {
    ...plan,
    targets: plan.targets.filter((t) => !later.has(t.version.assetId)),
    assetIds: plan.assetIds.filter((id) => !later.has(id)),
    reencode: [],
  };
}

/**
 * The plan for one asset once its re-encode is done (SPEC §28.3): every live version that uses
 * it, so copies are archived as selected versions.
 */
export function planForAsset(db: Db, assetId: string): LosslessPlan {
  const versions = db
    .select({ id: trackVersions.id })
    .from(trackVersions)
    .where(and(eq(trackVersions.assetId, assetId), visibleVersion()))
    .all();
  return planLosslessRemoval(
    db,
    versions.map((v) => ({ kind: "version" as const, id: v.id })),
  );
}

/** A version whose full quality went: a selected one, or a copy sharing its asset. */
export interface ArchivedVersion {
  versionId: string;
  trackId: string;
  songId: string;
  projectId: string;
  number: number;
  /** Not selected itself: a copy sharing the asset (SPEC §26.6). */
  copy: boolean;
}

/**
 * Applies a plan (SPEC §26.4): removes the flac (with its seek index), original, wavmeta and wavpack
 * variants of each asset
 * (usage drops at once, the blobs become GC candidates) and marks every version using those
 * assets archived — copies too, since they share the files. Call inside a transaction.
 */
export function applyLosslessRemoval(
  db: Db,
  plan: LosslessPlan,
  userId: string | null,
  now: number = Date.now(),
  reason: ArchivedReason = "removed",
): ArchivedVersion[] {
  for (const assetId of plan.assetIds) {
    for (const variant of REMOVED) removeVariant(db, assetId, variant, now);
  }
  const selected = new Set(plan.targets.map((t) => t.version.id));
  return archiveVersionsOfAssets(db, plan.assetIds, userId, reason, now).map((v) => ({
    ...v,
    copy: !selected.has(v.versionId),
  }));
}

/**
 * Marks every not yet archived version using the assets as archived (SPEC §26.4, §28.2):
 * when, by whom and why. `copy` is false here; callers that know the selection set it. Call
 * inside a transaction.
 */
export function archiveVersionsOfAssets(
  db: Db,
  assetIds: readonly string[],
  by: string | null,
  reason: ArchivedReason,
  now: number = Date.now(),
): ArchivedVersion[] {
  if (assetIds.length === 0) return [];
  const rows = db
    .select({
      id: trackVersions.id,
      trackId: trackVersions.trackId,
      number: trackVersions.number,
      songId: tracks.songId,
      projectId: songs.projectId,
      archivedAt: trackVersions.archivedAt,
    })
    .from(trackVersions)
    .innerJoin(tracks, eq(tracks.id, trackVersions.trackId))
    .innerJoin(songs, eq(songs.id, tracks.songId))
    .where(inArray(trackVersions.assetId, [...assetIds]))
    .all()
    .filter((r) => r.archivedAt === null);
  if (rows.length === 0) return [];
  db.update(trackVersions)
    .set({ archivedAt: now, archivedBy: by, archivedReason: reason })
    .where(
      inArray(
        trackVersions.id,
        rows.map((r) => r.id),
      ),
    )
    .run();
  return rows.map((r) => ({
    versionId: r.id,
    trackId: r.trackId,
    songId: r.songId,
    projectId: r.projectId,
    number: r.number,
    copy: false,
  }));
}

/** Whether any version using the asset had its full quality removed (ingest must not redo it). */
export function assetLosslessRemoved(db: Db, assetId: string): boolean {
  return (
    db
      .select({ id: trackVersions.id })
      .from(trackVersions)
      .where(and(eq(trackVersions.assetId, assetId), sql`${trackVersions.archivedAt} IS NOT NULL`))
      .limit(1)
      .get() !== undefined
  );
}

/**
 * The song list's lossy badge (SPEC §26.4) for every live song of a project: over the current
 * versions of the songs' live tracks (not the automatic mix) whose files are ready, "all" when
 * each is lossy (a lossy source or full quality removed), "partial" when some are. One query.
 */
export function lossyBySong(db: Db, projectId: string): Map<string, SongLossy> {
  const rows = db
    .select({
      songId: tracks.songId,
      archivedAt: trackVersions.archivedAt,
      lossless: sql<number | null>`json_extract(${assets.probe}, '$.lossless')`,
      derived: sql<number | null>`json_extract(${assets.probe}, '$.derivedFromLossy')`,
    })
    .from(tracks)
    .innerJoin(songs, eq(songs.id, tracks.songId))
    .innerJoin(trackVersions, eq(trackVersions.id, tracks.currentVersionId))
    .innerJoin(assets, eq(assets.id, trackVersions.assetId))
    .where(
      and(
        eq(songs.projectId, projectId),
        isNull(songs.deletedAt),
        isNull(tracks.deletedAt),
        visibleVersion(),
        eq(assets.status, "ready"),
      ),
    )
    .all();
  const flags = new Map<string, boolean[]>();
  for (const r of rows) {
    const list = flags.get(r.songId) ?? [];
    list.push(r.archivedAt !== null || r.lossless === 0 || r.derived === 1);
    flags.set(r.songId, list);
  }
  return new Map([...flags].map(([songId, f]) => [songId, songLossyOf(f)]));
}
