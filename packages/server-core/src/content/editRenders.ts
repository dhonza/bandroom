import {
  clipsInRange,
  editedTracks,
  editSongTrackName,
  remapSteps,
  replay,
  uuidv7,
  DEFAULT_EDIT_SONG_NAMING,
  EditClipSchema,
  type EditBounceRange,
  type EditClip,
  type EditOutcomeKind,
  type EditRenderProgress,
  type EditSongNaming,
  type EditState,
  type RemapStep,
} from "@bandroom/shared";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/connection";
import { editRenders, editSessions, jobs, tracks, trackVersions } from "../db/schema";
import { recordEvent, type EventInput } from "../events/record";
import { cancelJob, enqueueJob } from "../jobs/queue";
import { assetProbe, createAsset, getAsset, type AssetRow } from "../media/assets";
import type { Probe } from "../media/probe";
import { getVariant } from "../media/variants";
import { sessionState, type EditSessionRow } from "./editSessions";
import { releaseUnreferencedAssets } from "./trash";

/**
 * Apply & Bounce (SPEC §24.8–§24.10, §24.14): what an edit session renders, the hidden versions
 * the renders go into, and the session's `applying` state (request, failure, retry, cancel).
 * The commit is in `editCommit.ts`, the worker job in `media/render.ts`.
 */

export type EditRenderRow = typeof editRenders.$inferSelect;

export const RENDER_JOB_TYPE = "audio.render";
export const EDIT_COMMIT_JOB_TYPE = "edit.commit";
/** Renders run below uploads (like bounces), one at a time in the worker. */
export const RENDER_PRIORITY = -1;

/** Full quality when there is any; Opus for versions whose full quality was removed. */
export const RENDER_SOURCE_VARIANTS = ["flac", "original", "opus"] as const;
export type RenderSourceVariant = (typeof RENDER_SOURCE_VARIANTS)[number];

/** The internal outcome stored on the session while it renders (the DTO shows a part). */
export const StoredOutcomeSchema = z.object({
  kind: z.enum(["apply", "bounceVersions", "bounceTracks", "bounceSongs"]),
  by: z.string(),
  at: z.number(),
  keepEditing: z.boolean().default(false),
  carryTempo: z.boolean().default(false),
  naming: z
    .object({
      title: z.enum(["name", "sessionAndName"]),
      numbered: z.boolean(),
      trackNames: z.enum(["keep", "rangePrefix"]),
    })
    .optional(),
  ranges: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        startFrame: z.number(),
        endFrame: z.number(),
        title: z.string(),
      }),
    )
    .optional(),
  /** Apply: edited tracks left without any clip (their current version goes to the Trash). */
  emptied: z.array(z.string()).default([]),
  /** After the commit. */
  versionIds: z.array(z.string()).optional(),
  trackIds: z.array(z.string()).optional(),
  songIds: z.array(z.string()).optional(),
  /** Apply: the replaced versions (now in the Trash). */
  replacedVersionIds: z.array(z.string()).optional(),
});
export type StoredOutcome = z.infer<typeof StoredOutcomeSchema>;

export function parseOutcome(json: string | null): StoredOutcome | null {
  if (json === null) return null;
  try {
    const p = StoredOutcomeSchema.safeParse(JSON.parse(json));
    return p.success ? p.data : null;
  } catch {
    return null;
  }
}

export function listEditRenders(db: Db, sessionId: string): EditRenderRow[] {
  return db
    .select()
    .from(editRenders)
    .where(eq(editRenders.sessionId, sessionId))
    .orderBy(asc(editRenders.rangeIndex), asc(editRenders.createdAt), asc(editRenders.outputKey))
    .all();
}

export function getEditRender(db: Db, id: string): EditRenderRow | undefined {
  return db.select().from(editRenders).where(eq(editRenders.id, id)).get();
}

export function renderClips(r: Pick<EditRenderRow, "clips">): EditClip[] {
  return z.array(EditClipSchema).parse(JSON.parse(r.clips));
}

// ——— sources ———————————————————————————————————————————————————————————————————————————

export interface ClipSource {
  versionId: string;
  asset: AssetRow;
  variant: RenderSourceVariant;
  probe: Probe | null;
  /** Sample rate and channels of the file read. */
  sampleRate: number;
  channels: 1 | 2;
  /** True mono (not dual-mono): −3 dB when up-mixed. */
  plainMono: boolean;
  /** No full quality: a lossy upload, or full quality removed (or rendered from such). */
  lossy: boolean;
  archived: boolean;
}

function variantMeta(db: Db, assetId: string, variant: string): Record<string, unknown> {
  const v = getVariant(db, assetId, variant);
  try {
    const m: unknown = v ? JSON.parse(v.meta) : {};
    return typeof m === "object" && m !== null ? (m as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The file a clip of `versionId` renders from (SPEC §24.10): its `flac` when there is one (24-bit
 * near-lossless for float sources), else the `original` (lossy uploads), else the `opus`
 * (full quality removed). Null when the version or its files are gone.
 */
export function resolveClipSource(db: Db, versionId: string): ClipSource | null {
  const version = db.select().from(trackVersions).where(eq(trackVersions.id, versionId)).get();
  const asset = version && getAsset(db, version.assetId);
  if (!asset) return null;
  const variant = RENDER_SOURCE_VARIANTS.find((v) => getVariant(db, asset.id, v));
  if (!variant) return null;
  const probe = assetProbe(asset);
  const meta = variantMeta(db, asset.id, variant);
  const metaRate = typeof meta.sampleRate === "number" ? meta.sampleRate : null;
  const sampleRate = variant === "opus" ? 48_000 : (metaRate ?? probe?.sampleRate ?? 48_000);
  const dual = probe?.dualMono === true;
  const oneChannel = probe?.channels === 1 || (dual && variant !== "original");
  return {
    versionId,
    asset,
    variant,
    probe,
    sampleRate,
    channels: oneChannel ? 1 : 2,
    plainMono: probe?.channels === 1 && !dual,
    lossy:
      variant !== "flac" && !(variant === "original" && probe?.lossless === true)
        ? true
        : probe?.derivedFromLossy === true,
    archived: variant === "opus",
  };
}

// ——— planning ———————————————————————————————————————————————————————————————————————————

export interface PlannedOutput {
  key: string;
  trackId: string;
  rangeId: string | null;
  rangeIndex: number | null;
  /** Name of the output track; split into songs: the new song's title too. */
  title: string;
  songTitle: string | null;
  clips: EditClip[];
  offsetSamples: number;
  lengthFrames: number;
}

export interface EditPlan {
  kind: EditOutcomeKind;
  state: EditState;
  steps: RemapStep[];
  outputs: PlannedOutput[];
  /** Apply: edited tracks left without clips. */
  emptied: string[];
}

export interface PlanRequest {
  kind: EditOutcomeKind;
  ranges?: readonly EditBounceRange[];
  naming?: EditSongNaming;
}

function output(
  base: Omit<PlannedOutput, "offsetSamples" | "lengthFrames" | "clips">,
  clips: EditClip[],
): PlannedOutput | null {
  if (clips.length === 0) return null;
  const start = Math.min(...clips.map((c) => c.startFrame));
  const end = Math.max(...clips.map((c) => c.startFrame + c.lengthFrames));
  return { ...base, clips, offsetSamples: start, lengthFrames: end - start };
}

/**
 * What an Apply/Bounce renders (SPEC §24.8, §24.9): one output per edited track (its clips on
 * the session timeline), or, for split into songs, one per range and track with audio in it
 * (clips cut to the range, from 0). Track names: the track's own (Apply, new versions),
 * `<track> (edit)` (new tracks), or by the naming options (new songs).
 */
export function planEdit(db: Db, row: EditSessionRow, req: PlanRequest): EditPlan {
  const s = sessionState(row);
  const state = replay(s.base, s.ops, s.cursor);
  const steps = remapSteps(s.base, s.ops, s.cursor);
  const names = new Map(
    db
      .select({ id: tracks.id, name: tracks.name })
      .from(tracks)
      .where(
        inArray(
          tracks.id,
          s.base.tracks.map((t) => t.trackId),
        ),
      )
      .all()
      .map((t) => [t.id, t.name]),
  );
  const clipsOf = (trackId: string) => state.tracks.find((t) => t.trackId === trackId)?.clips ?? [];
  const outputs: PlannedOutput[] = [];
  const emptied: string[] = [];
  if (req.kind === "bounceSongs") {
    const naming = req.naming ?? DEFAULT_EDIT_SONG_NAMING;
    (req.ranges ?? []).forEach((r, i) => {
      for (const t of s.base.tracks) {
        const name = names.get(t.trackId) ?? "";
        const o = output(
          {
            key: `${r.id}:${t.trackId}`,
            trackId: t.trackId,
            rangeId: r.id,
            rangeIndex: i,
            title: editSongTrackName(r, name, naming),
            songTitle: r.title,
          },
          clipsInRange(clipsOf(t.trackId), r.startFrame, r.endFrame, s.options.fades),
        );
        if (o) outputs.push(o);
      }
    });
    return { kind: req.kind, state, steps, outputs, emptied };
  }
  for (const trackId of editedTracks(s.base, state)) {
    const name = names.get(trackId) ?? "";
    const o = output(
      {
        key: trackId,
        trackId,
        rangeId: null,
        rangeIndex: null,
        title: req.kind === "bounceTracks" ? `${name} (edit)`.slice(0, 120) : name,
        songTitle: null,
      },
      clipsOf(trackId),
    );
    if (o) outputs.push(o);
    else if (req.kind === "apply") emptied.push(trackId);
  }
  return { kind: req.kind, state, steps, outputs, emptied };
}

/** Channels of an output: mono only when every clip is a true mono file (SPEC §24.5). */
export function outputChannels(sources: readonly (ClipSource | null)[]): 1 | 2 {
  return sources.length > 0 && sources.every((s) => s?.plainMono === true) ? 1 : 2;
}

/** Bytes of the rendered 24-bit WAV of an output. */
export function outputBytes(o: Pick<PlannedOutput, "lengthFrames">, channels: 1 | 2): number {
  return o.lengthFrames * channels * 3 + 44;
}

/** The clips' sources, by version id (null when gone). */
export function planSources(db: Db, plan: EditPlan): Map<string, ClipSource | null> {
  const out = new Map<string, ClipSource | null>();
  for (const o of plan.outputs)
    for (const c of o.clips)
      if (!out.has(c.sourceVersionId))
        out.set(c.sourceVersionId, resolveClipSource(db, c.sourceVersionId));
  return out;
}

/** Total bytes of the renders (what the quota and disk checks use). */
export function planBytes(plan: EditPlan, sources: Map<string, ClipSource | null>): number {
  return plan.outputs.reduce(
    (sum, o) =>
      sum +
      outputBytes(o, outputChannels(o.clips.map((c) => sources.get(c.sourceVersionId) ?? null))),
    0,
  );
}

// ——— request —————————————————————————————————————————————————————————————————————————————

export interface EditActor {
  userId: string;
  sessionId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  apiKeyId?: string | null;
}

const eventOf = (row: Pick<EditSessionRow, "id" | "projectId" | "songId">, a: EditActor) =>
  ({
    actorUserId: a.userId,
    sessionId: a.sessionId ?? null,
    ip: a.ip ?? null,
    userAgent: a.userAgent ?? null,
    apiKeyId: a.apiKeyId ?? null,
    projectId: row.projectId,
    songId: row.songId,
    targetType: "editSession",
    targetId: row.id,
  }) satisfies Partial<EventInput>;

function enqueueRender(
  db: Db,
  r: Pick<EditRenderRow, "id" | "sessionId">,
  row: EditSessionRow,
  by: string,
  now: number,
) {
  enqueueJob(
    db,
    {
      type: RENDER_JOB_TYPE,
      capability: RENDER_JOB_TYPE,
      payload: {
        renderId: r.id,
        sessionId: r.sessionId,
        projectId: row.projectId,
        songId: row.songId,
      },
      dedupeKey: `render:${r.id}`,
      priority: RENDER_PRIORITY,
      createdBy: by,
    },
    now,
  );
}

/**
 * Starts an Apply/Bounce (SPEC §24.8) in one transaction: the session goes `open → applying`
 * (guarded on its rev), earlier renders that never committed are purged, and every output gets
 * a queued asset owned by the user, a hidden version on its source track (`edit_session_id` set,
 * number 0 until the commit numbers it), an `edit_renders` row with its frozen clips and an
 * `audio.render` job. Undefined when the session changed meanwhile.
 */
export function requestEditRenders(
  db: Db,
  row: EditSessionRow,
  input: {
    plan: EditPlan;
    rev: number;
    actor: EditActor;
    keepEditing?: boolean;
    carryTempo?: boolean;
    naming?: EditSongNaming;
    ranges?: readonly EditBounceRange[];
  },
  now: number = Date.now(),
): EditSessionRow | undefined {
  const { plan, actor } = input;
  const outcome: StoredOutcome = {
    kind: plan.kind,
    by: actor.userId,
    at: now,
    keepEditing: plan.kind === "bounceSongs" && input.keepEditing === true,
    carryTempo: input.carryTempo === true,
    ...(input.naming && { naming: input.naming }),
    ...(plan.kind === "bounceSongs" && { ranges: [...(input.ranges ?? [])] }),
    emptied: plan.emptied,
  };
  return db.transaction(() => {
    const next = db
      .update(editSessions)
      .set({
        status: "applying",
        outcome: JSON.stringify(outcome),
        error: null,
        rev: row.rev + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(editSessions.id, row.id),
          eq(editSessions.status, "open"),
          eq(editSessions.rev, input.rev),
        ),
      )
      .returning()
      .all()
      .at(0);
    if (!next) return undefined;
    purgeEditRenders(db, row.id, now);
    const sources = planSources(db, plan);
    for (const o of plan.outputs) {
      const lossy = o.clips.some((c) => sources.get(c.sourceVersionId)?.lossy === true);
      const asset = createAsset(
        db,
        {
          kind: "audio",
          originalFilename: `${(o.songTitle ? `${o.songTitle} – ${o.title}` : o.title).slice(0, 200)}.wav`,
          mimeType: "audio/wav",
          sizeBytes: 0, // set when rendered
          originalHash: "",
          uploadedBy: actor.userId,
        },
        now,
      );
      const version = db
        .insert(trackVersions)
        .values({
          id: uuidv7(now),
          trackId: o.trackId,
          number: 0,
          stackOrder: 0,
          assetId: asset.id,
          offsetSamples: o.offsetSamples,
          gainDb: 0, // the clips' gains are in the render
          source: "edit",
          uploadedBy: actor.userId,
          createdAt: now,
          editSessionId: row.id,
        })
        .returning()
        .get();
      const render = db
        .insert(editRenders)
        .values({
          id: uuidv7(now),
          sessionId: row.id,
          outputKey: o.key,
          trackId: o.trackId,
          rangeId: o.rangeId,
          rangeIndex: o.rangeIndex,
          title: o.title,
          songTitle: o.songTitle,
          versionId: version.id,
          assetId: asset.id,
          status: "queued",
          clips: JSON.stringify(o.clips),
          offsetSamples: o.offsetSamples,
          lengthFrames: o.lengthFrames,
          lossySource: lossy,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      enqueueRender(db, render, next, actor.userId, now);
    }
    recordEvent(db, {
      ...eventOf(row, actor),
      ts: now,
      action: "edit.render_requested",
      details: {
        kind: plan.kind,
        outputs: plan.outputs.length,
        tracks: [...new Set(plan.outputs.map((o) => o.trackId))],
        emptied: plan.emptied,
        ...(plan.kind === "bounceSongs" && { songs: input.ranges?.length ?? 0 }),
      },
    });
    // Nothing to render (an Apply that only empties tracks): commit right away.
    if (plan.outputs.length === 0) enqueueEditCommit(db, row.id, actor.userId, now);
    return next;
  });
}

// ——— worker hooks ————————————————————————————————————————————————————————————————————————

export function enqueueEditCommit(db: Db, sessionId: string, by: string | null, now = Date.now()) {
  enqueueJob(
    db,
    {
      type: EDIT_COMMIT_JOB_TYPE,
      capability: EDIT_COMMIT_JOB_TYPE,
      payload: { sessionId },
      dedupeKey: `edit-commit:${sessionId}`,
      priority: RENDER_PRIORITY,
      createdBy: by,
    },
    now,
  );
}

/**
 * Called when a job on an asset finished or failed for good (the runner): when the asset is a
 * render of an applying session, the commit job checks whether the session can commit now.
 */
export function editAssetSettled(db: Db, assetId: string): boolean {
  const r = db
    .select({ sessionId: editRenders.sessionId, status: editSessions.status })
    .from(editRenders)
    .innerJoin(editSessions, eq(editSessions.id, editRenders.sessionId))
    .where(eq(editRenders.assetId, assetId))
    .get();
  if (!r || r.status !== "applying") return false;
  enqueueEditCommit(db, r.sessionId, null);
  return true;
}

export function setRenderStatus(
  db: Db,
  id: string,
  patch: Partial<Pick<EditRenderRow, "status" | "error" | "peakDb" | "attempts">>,
  now = Date.now(),
): void {
  db.update(editRenders)
    .set({ ...patch, updatedAt: now })
    .where(eq(editRenders.id, id))
    .run();
}

function cancelRenderJobs(db: Db, renders: readonly EditRenderRow[], now: number): void {
  const keys = renders.flatMap((r) => [
    `render:${r.id}`,
    ...(r.assetId ? [`ingest:${r.assetId}`] : []),
  ]);
  if (keys.length === 0) return;
  for (const j of db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(inArray(jobs.dedupeKey, keys), inArray(jobs.status, ["queued", "running"])))
    .all())
    cancelJob(db, j.id, now);
}

/**
 * A render (or its ingest) failed for good (SPEC §24.14): nothing is committed; the render is
 * `failed`, the other unfinished ones `skipped` (their jobs cancelled), and the session is `open`
 * again with the error, so the editor can retry, apply or bounce otherwise, or cancel. The
 * hidden versions stay for the retry. False when the session was no longer applying.
 */
export function failEditSession(
  db: Db,
  sessionId: string,
  renderId: string | null,
  error: string,
  now: number = Date.now(),
): EditSessionRow | undefined {
  return db.transaction(() => {
    const row = db.select().from(editSessions).where(eq(editSessions.id, sessionId)).get();
    if (!row || row.status !== "applying") return undefined;
    const message = error.slice(0, 500);
    if (renderId) setRenderStatus(db, renderId, { status: "failed", error: message }, now);
    const others = listEditRenders(db, sessionId).filter(
      (r) => r.id !== renderId && (r.status === "queued" || r.status === "running"),
    );
    cancelRenderJobs(db, others, now);
    for (const r of others) setRenderStatus(db, r.id, { status: "skipped" }, now);
    const next = db
      .update(editSessions)
      .set({ status: "open", error: message, rev: row.rev + 1, updatedAt: now })
      .where(and(eq(editSessions.id, sessionId), eq(editSessions.status, "applying")))
      .returning()
      .get();
    const outcome = parseOutcome(row.outcome);
    recordEvent(db, {
      ts: now,
      actorType: "worker",
      actorUserId: outcome?.by ?? null,
      action: "edit.failed",
      projectId: row.projectId,
      songId: row.songId,
      targetType: "editSession",
      targetId: row.id,
      details: { renderId, error: message, kind: outcome?.kind ?? null },
    });
    return next;
  });
}

/**
 * Removes the renders of a session that never committed: their hidden versions, their assets
 * (with the files, so the usage drops) and the rows; queued jobs are cancelled.
 */
export function purgeEditRenders(db: Db, sessionId: string, now: number = Date.now()): number {
  const renders = listEditRenders(db, sessionId);
  if (renders.length === 0) return 0;
  cancelRenderJobs(db, renders, now);
  const hidden = db
    .select({ id: trackVersions.id, assetId: trackVersions.assetId })
    .from(trackVersions)
    .where(eq(trackVersions.editSessionId, sessionId))
    .all();
  if (hidden.length > 0)
    db.delete(trackVersions)
      .where(
        inArray(
          trackVersions.id,
          hidden.map((h) => h.id),
        ),
      )
      .run();
  releaseUnreferencedAssets(
    db,
    [...hidden.map((h) => h.assetId), ...renders.flatMap((r) => (r.assetId ? [r.assetId] : []))],
    now,
  );
  db.delete(editRenders).where(eq(editRenders.sessionId, sessionId)).run();
  return renders.length;
}

/** Whether the session has renders that were never committed (a failed Apply/Bounce). */
export function hasPendingRenders(db: Db, sessionId: string): boolean {
  return (
    db
      .select({ id: editRenders.id })
      .from(editRenders)
      .where(eq(editRenders.sessionId, sessionId))
      .limit(1)
      .get() !== undefined
  );
}

/**
 * Cancels a session (SPEC §24.14): `open`, or `applying` (queued renders skipped, the running
 * one discarded: its job is cancelled and its hidden version and asset purged with the rest).
 * Undefined when it was neither.
 */
export function cancelEditSessionWithRenders(
  db: Db,
  row: EditSessionRow,
  now: number = Date.now(),
): EditSessionRow | undefined {
  return db.transaction(() => {
    const next = db
      .update(editSessions)
      .set({ status: "cancelled", rev: row.rev + 1, updatedAt: now, finishedAt: now })
      .where(and(eq(editSessions.id, row.id), inArray(editSessions.status, ["open", "applying"])))
      .returning()
      .all()
      .at(0);
    if (!next) return undefined;
    db.update(editRenders)
      .set({ status: "skipped", updatedAt: now })
      .where(
        and(eq(editRenders.sessionId, row.id), inArray(editRenders.status, ["queued", "running"])),
      )
      .run();
    purgeEditRenders(db, row.id, now);
    return next;
  });
}

/**
 * Retry (SPEC §24.14): the failed and skipped renders of the last Apply/Bounce are queued again
 * (renders whose file was stored only re-run the ingest) and the session is `applying` again.
 * Undefined when there is nothing to retry or the session changed.
 */
export function retryEditRenders(
  db: Db,
  row: EditSessionRow,
  actor: EditActor,
  now: number = Date.now(),
): EditSessionRow | undefined {
  return db.transaction(() => {
    const renders = listEditRenders(db, row.id).filter(
      (r) => r.status === "failed" || r.status === "skipped",
    );
    if (row.status !== "open" || renders.length === 0 || parseOutcome(row.outcome) === null)
      return undefined;
    const next = db
      .update(editSessions)
      .set({ status: "applying", error: null, rev: row.rev + 1, updatedAt: now })
      .where(
        and(
          eq(editSessions.id, row.id),
          eq(editSessions.status, "open"),
          eq(editSessions.rev, row.rev),
        ),
      )
      .returning()
      .all()
      .at(0);
    if (!next) return undefined;
    for (const r of renders) {
      setRenderStatus(db, r.id, { status: "queued", error: null }, now);
      enqueueRender(db, r, next, actor.userId, now);
    }
    recordEvent(db, {
      ...eventOf(row, actor),
      ts: now,
      action: "edit.retried",
      details: { renders: renders.map((r) => r.id) },
    });
    return next;
  });
}

// ——— progress ————————————————————————————————————————————————————————————————————————————

function jobProgress(db: Db, dedupeKey: string): { status: string; progress: number } | null {
  return (
    db
      .select({ status: jobs.status, progress: jobs.progress })
      .from(jobs)
      .where(eq(jobs.dedupeKey, dedupeKey))
      .orderBy(desc(jobs.createdAt))
      .get() ?? null
  );
}

/**
 * The renders of a session with their progress (SPEC §24.11): the render job counts for the
 * first half, the ingest of the rendered file for the second.
 */
export function editRenderProgress(db: Db, sessionId: string): EditRenderProgress[] {
  return listEditRenders(db, sessionId).map((r) => {
    const asset = r.assetId ? getAsset(db, r.assetId) : undefined;
    let phase: EditRenderProgress["phase"];
    let progress: number;
    if (r.status === "failed" || r.status === "skipped") {
      phase = "failed";
      progress = 0;
    } else if (r.status !== "done") {
      phase = "render";
      progress =
        r.status === "running" ? 0.5 * (jobProgress(db, `render:${r.id}`)?.progress ?? 0) : 0;
    } else if (asset?.status === "ready") {
      phase = "ready";
      progress = 1;
    } else if (asset?.status === "failed") {
      phase = "failed";
      progress = 0.5;
    } else {
      phase = "ingest";
      progress =
        0.5 + 0.5 * (r.assetId ? (jobProgress(db, `ingest:${r.assetId}`)?.progress ?? 0) : 0);
    }
    return {
      id: r.id,
      trackId: r.trackId,
      rangeId: r.rangeId,
      status: r.status,
      phase,
      progress: Math.max(0, Math.min(1, progress)),
      peakDb: r.peakDb,
      error: r.error ?? (phase === "failed" ? (asset?.error ?? null) : null),
    };
  });
}
