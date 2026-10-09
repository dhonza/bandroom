import {
  dbToGain,
  DEFAULT_EDIT_SONG_NAMING,
  editSongRanges,
  editSongTitle,
  songEndFrame,
  type EditBounceRange,
  type EditOp,
  type EditOutcomeKind,
  type EditReview,
  type EditReviewQuerySchema,
  type EditReviewWarning,
  type EditReviewWarningCode,
  type EditSongNaming,
  type EditSongRange,
} from "@bandroom/shared";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import type { Db } from "../db/connection";
import { songs, tracks } from "../db/schema";
import { QUOTA_OVERHEAD } from "../media/quota";
import { decodeDat } from "../media/peaks";
import {
  outputBytes,
  outputChannels,
  planEdit,
  planSources,
  type ClipSource,
  type EditPlan,
  type PlannedOutput,
} from "./editRenders";
import { remapPreview } from "./editRemap";
import { sessionState, type EditSessionRow } from "./editSessions";

/**
 * The review of an Apply/Bounce (SPEC §24.8): what will be rendered, how big it is against the
 * applying user's quota and the free disk, warnings, and what the timeline follow-up changes.
 * Nothing is written.
 */

type ReviewQuery = z.output<typeof EditReviewQuerySchema>;

/** Seconds of processing per second of rendered audio (SPEC §24.8). */
export const RENDER_SEC_PER_SEC = 0.15;

export interface ReviewDeps {
  /** The peaks file (`audiowaveform` .dat) of an asset, or null. */
  peaks: (assetId: string) => Buffer | null;
  /** Bytes the user may still store (quota − usage); null = unlimited. */
  quotaRemainingBytes: number | null;
  diskFreeBytes: number | null;
  /** Free disk that must remain after the renders. */
  minFreeBytes: number;
}

/** The split-into-songs ranges of the session's edited timeline (SPEC §24.9). */
export function editRangesOf(
  db: Db,
  row: EditSessionRow,
  plan: Pick<EditPlan, "state" | "steps">,
): { sections: EditSongRange[]; markers: EditSongRange[] } {
  const preview = remapPreview(db, row.songId, plan.steps, row.id);
  return editSongRanges(preview.markers.items, plan.state.tracks, songEndFrame(plan.state));
}

/** The ranges a review query picks, with their default titles (SPEC §24.9). */
export function reviewRanges(
  candidates: { sections: EditSongRange[]; markers: EditSongRange[] },
  query: Pick<ReviewQuery, "by" | "ranges">,
  naming: EditSongNaming,
  sessionTitle: string,
): EditBounceRange[] {
  const list = query.by === "markers" ? candidates.markers : candidates.sections;
  const wanted = query.ranges ? new Set(query.ranges.split(",").filter(Boolean)) : null;
  const picked = wanted ? list.filter((r) => wanted.has(r.id)) : list;
  return picked.map((r, i) => ({
    id: r.id,
    name: r.name,
    startFrame: r.startFrame,
    endFrame: r.endFrame,
    title: editSongTitle(r, i, picked.length, naming, sessionTitle),
  }));
}

const peakCache = new WeakMap<object, Map<string, { spp: number; pairs: Int8Array } | null>>();

function maxPeak(
  deps: ReviewDeps,
  src: ClipSource,
  fromFrame: number,
  frames: number,
): number | null {
  let cache = peakCache.get(deps);
  if (!cache) {
    cache = new Map();
    peakCache.set(deps, cache);
  }
  let dat = cache.get(src.asset.id);
  if (dat === undefined) {
    const buf = deps.peaks(src.asset.id);
    try {
      dat = buf ? decodeDat(buf) : null;
    } catch {
      dat = null;
    }
    cache.set(src.asset.id, dat);
  }
  if (!dat) return null;
  const rate = src.probe?.sampleRate ?? src.sampleRate;
  const from = Math.floor((fromFrame * rate) / 48_000 / dat.spp);
  const to = Math.ceil(((fromFrame + frames) * rate) / 48_000 / dat.spp);
  let m = 0;
  for (let i = Math.max(0, from); i < Math.min(dat.pairs.length / 2, to); i++)
    m = Math.max(m, Math.abs(dat.pairs[2 * i] ?? 0), Math.abs(dat.pairs[2 * i + 1] ?? 0));
  return m / 127;
}

/**
 * Peak of an output in dBFS estimated from the sources' waveform peaks (SPEC §24.8): each clip's
 * loudest peak × its gain, summed where clips overlap (fades ignored, so it errs high).
 */
export function estimatePeakDb(
  o: PlannedOutput,
  sources: Map<string, ClipSource | null>,
  deps: ReviewDeps,
): number | null {
  const channels = outputChannels(o.clips.map((c) => sources.get(c.sourceVersionId) ?? null));
  const edges: { at: number; d: number }[] = [];
  for (const c of o.clips) {
    const src = sources.get(c.sourceVersionId);
    const p = src ? maxPeak(deps, src, c.sourceStartFrame, c.lengthFrames) : null;
    if (!src || p === null) return null;
    const upmix = channels === 2 && src.plainMono ? Math.SQRT1_2 : 1;
    const a = p * dbToGain(c.gainDb) * upmix;
    edges.push({ at: c.startFrame, d: a }, { at: c.startFrame + c.lengthFrames, d: -a });
  }
  edges.sort((x, y) => x.at - y.at || x.d - y.d);
  let cur = 0;
  let max = 0;
  for (const e of edges) {
    cur += e.d;
    max = Math.max(max, cur);
  }
  return max > 0 ? Math.round(20 * Math.log10(max) * 100) / 100 : null;
}

/**
 * Tracks shifted by ripples on a subset of tracks (SPEC §24.3): the largest group of equally
 * shifted tracks counts as in sync, the others are out of sync.
 */
export function outOfSyncTracks(
  trackIds: readonly string[],
  ops: readonly EditOp[],
  cursor: number,
): string[] {
  const shift = new Map(trackIds.map((t) => [t, 0]));
  for (const op of ops.slice(0, cursor)) {
    if (op.type !== "cut") continue;
    const chosen = new Set(op.tracks);
    if (trackIds.every((t) => chosen.has(t))) continue;
    for (const t of op.tracks)
      if (shift.has(t)) shift.set(t, (shift.get(t) ?? 0) + op.range.end - op.range.start);
  }
  const groups = new Map<number, string[]>();
  for (const [t, s] of shift) groups.set(s, [...(groups.get(s) ?? []), t]);
  if (groups.size <= 1) return [];
  const largest = [...groups.values()].reduce((a, b) => (b.length > a.length ? b : a));
  return trackIds.filter((t) => !largest.includes(t));
}

export function buildEditReview(
  db: Db,
  row: EditSessionRow,
  query: ReviewQuery & { kind: EditOutcomeKind },
  deps: ReviewDeps,
): EditReview {
  const s = sessionState(row);
  const songTitle =
    db.select({ t: songs.title }).from(songs).where(eq(songs.id, row.songId)).get()?.t ?? "";
  const naming: EditSongNaming = {
    ...DEFAULT_EDIT_SONG_NAMING,
    ...(query.title && { title: query.title }),
    ...(query.numbered !== undefined && { numbered: query.numbered }),
    ...(query.trackNames && { trackNames: query.trackNames }),
  };
  const base = planEdit(db, row, { kind: "apply" });
  const ranges =
    query.kind === "bounceSongs" ? editRangesOf(db, row, base) : { sections: [], markers: [] };
  const plan =
    query.kind === "bounceSongs"
      ? planEdit(db, row, {
          kind: "bounceSongs",
          ranges: reviewRanges(ranges, query, naming, songTitle),
          naming,
        })
      : planEdit(db, row, { kind: query.kind });
  const sources = planSources(db, plan);
  const baseLength = new Map(s.base.tracks.map((t) => [t.trackId, t.lengthFrames]));
  const names = new Map(
    db
      .select({ id: tracks.id, name: tracks.name })
      .from(tracks)
      .where(eq(tracks.songId, row.songId))
      .all()
      .map((t) => [t.id, t.name]),
  );
  const outputs = plan.outputs.map((o) => {
    const channels = outputChannels(o.clips.map((c) => sources.get(c.sourceVersionId) ?? null));
    const len = baseLength.get(o.trackId);
    return {
      key: o.key,
      trackId: o.trackId,
      trackName: names.get(o.trackId) ?? "",
      title: o.title,
      rangeId: o.rangeId,
      songTitle: o.songTitle,
      oldDurationSec: plan.kind === "bounceSongs" || len === undefined ? null : len / 48_000,
      durationSec: o.lengthFrames / 48_000,
      estimatedBytes: outputBytes(o, channels),
      peakDb: estimatePeakDb(o, sources, deps),
    };
  });

  const warn = new Map<EditReviewWarningCode, Set<string>>();
  const add = (code: EditReviewWarningCode, trackId: string) => {
    const set = warn.get(code) ?? new Set<string>();
    set.add(trackId);
    warn.set(code, set);
  };
  for (const o of plan.outputs) {
    const srcs = o.clips.map((c) => sources.get(c.sourceVersionId) ?? null);
    if (srcs.some((x) => x?.archived)) add("ARCHIVED_SOURCE", o.trackId);
    else if (srcs.some((x) => x?.lossy)) add("LOSSY_SOURCE", o.trackId);
    if (new Set(srcs.map((x) => x?.sampleRate ?? 0)).size > 1) add("MIXED_SAMPLE_RATES", o.trackId);
  }
  for (const o of outputs) if (o.peakDb !== null && o.peakDb > 0) add("PEAK_OVER_0DBFS", o.trackId);
  for (const t of outOfSyncTracks(
    s.base.tracks.map((t) => t.trackId),
    s.ops,
    s.cursor,
  ))
    add("OUT_OF_SYNC", t);
  const warnings: EditReviewWarning[] = [...warn].map(([code, ids]) => ({
    code,
    trackIds: [...ids],
  }));

  const totalBytes = outputs.reduce((n, o) => n + o.estimatedBytes, 0);
  const remap =
    (plan.kind === "apply" || plan.kind === "bounceVersions") && plan.steps.length > 0
      ? remapPreview(db, row.songId, plan.steps, row.id).summary
      : null;
  return {
    kind: plan.kind,
    rev: row.rev,
    outputs,
    totalBytes,
    quotaRemainingBytes: deps.quotaRemainingBytes,
    diskFreeBytes: deps.diskFreeBytes,
    fitsQuota:
      deps.quotaRemainingBytes === null || totalBytes * QUOTA_OVERHEAD <= deps.quotaRemainingBytes,
    fitsDisk: deps.diskFreeBytes === null || deps.diskFreeBytes - totalBytes >= deps.minFreeBytes,
    estimatedSec:
      Math.round(RENDER_SEC_PER_SEC * outputs.reduce((n, o) => n + o.durationSec, 0) * 10) / 10,
    warnings,
    remap,
    ranges,
  };
}
