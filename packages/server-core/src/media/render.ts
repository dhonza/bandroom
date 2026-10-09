import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getUserById } from "../auth/users";
import { commitEditSession } from "../content/editCommit";
import {
  EDIT_COMMIT_JOB_TYPE,
  failEditSession,
  getEditRender,
  outputChannels,
  RENDER_JOB_TYPE,
  renderClips,
  resolveClipSource,
  setRenderStatus,
  type ClipSource,
} from "../content/editRenders";
import { getEditSessionRow } from "../content/editSessions";
import type { Db } from "../db/connection";
import { assets, editRenders } from "../db/schema";
import { recordEvent } from "../events/record";
import { getJob } from "../jobs/queue";
import { PermanentJobError, type JobContext, type JobHandler } from "../jobs/types";
import { measureLoudness } from "./analysis";
import { getAsset, setAssetProbe, setAssetStatus } from "./assets";
import { resampleFilter } from "./encode";
import { enqueueAudioIngest } from "./ingestJobs";
import { probeAudio } from "./probe";
import { quotaCheck } from "./quota";
import {
  RENDER_RATE,
  renderChannels,
  renderFilter,
  renderSpan,
  inputArgs,
  type RenderInput,
} from "./renderGraph";
import { ffmpegArgs, mediaTimeLimitMs, runTool, withTimeLimit, type ToolPaths } from "./tools";
import { getVariant } from "./variants";

/**
 * `audio.render` (SPEC §24.10): renders one output of an Apply/Bounce from its frozen clips into
 * a 48 kHz 24-bit WAV (no limiter; the true peak is stored), stores it as the hidden version's
 * `original` and queues the normal ingest. `edit.commit` commits the session once every render
 * is ingested (SPEC §24.8).
 */

export const RenderPayloadSchema = z.object({
  renderId: z.string(),
  sessionId: z.string(),
  projectId: z.string(),
  songId: z.string(),
});
export type RenderPayload = z.infer<typeof RenderPayloadSchema>;

/** Inputs per ffmpeg run; longer clip lists are mixed in groups first. */
export const MAX_RENDER_INPUTS = 32;

/** Stable start of a render's error when a source file is gone. */
export const RENDER_SOURCE_MISSING = "RENDER_SOURCE_MISSING";

const BITEXACT = ["-flags", "+bitexact", "-fflags", "+bitexact"];

/**
 * Renders clips into `out` (48 kHz WAV of `codec`), exactly `length` frames from timeline frame
 * `start`. More than {@link MAX_RENDER_INPUTS} clips are mixed in groups into float WAVs first
 * (each group is a few clips in timeline order), so one ffmpeg never opens hundreds of files.
 */
export async function renderInputs(
  ctx: { tools: ToolPaths; tmpDir: string; signal?: AbortSignal },
  inputs: readonly RenderInput[],
  out: {
    start: number;
    length: number;
    channels: 1 | 2;
    file: string;
    codec: "pcm_s24le" | "pcm_f32le";
  },
): Promise<void> {
  const resample = await resampleFilter(ctx.tools);
  let list = [...inputs].sort((a, b) => a.clip.startFrame - b.clip.startFrame);
  let round = 0;
  while (list.length > MAX_RENDER_INPUTS) {
    const groups: RenderInput[] = [];
    for (let g = 0; g * MAX_RENDER_INPUTS < list.length; g++) {
      const part = list.slice(g * MAX_RENDER_INPUTS, (g + 1) * MAX_RENDER_INPUTS);
      const span = renderSpan(part.map((p) => p.clip));
      const file = path.join(ctx.tmpDir, `group-${round}-${g}.wav`);
      await runFfmpeg(
        ctx,
        part,
        { ...span, channels: out.channels, file, codec: "pcm_f32le" },
        resample,
      );
      groups.push({
        source: {
          path: file,
          sampleRate: RENDER_RATE,
          channels: out.channels,
          plainMono: out.channels === 1,
        },
        clip: {
          sourceStartFrame: 0,
          startFrame: span.start,
          lengthFrames: span.length,
          gainDb: 0,
          fadeInFrames: 0,
          fadeOutFrames: 0,
          fadeInShape: "linear",
          fadeOutShape: "linear",
        },
      });
    }
    list = groups;
    round++;
  }
  await runFfmpeg(ctx, list, out, resample);
}

async function runFfmpeg(
  ctx: { tools: ToolPaths; signal?: AbortSignal },
  inputs: readonly RenderInput[],
  out: { start: number; length: number; channels: 1 | 2; file: string; codec: string },
  resample: string,
): Promise<void> {
  await runTool(
    ctx.tools.ffmpeg,
    ffmpegArgs(
      ...inputs.flatMap(inputArgs),
      "-filter_complex",
      renderFilter(inputs, { ...out, resample }),
      "-map",
      "[out]",
      "-ar",
      String(RENDER_RATE),
      "-ac",
      String(out.channels),
      "-c:a",
      out.codec,
      ...BITEXACT,
      "-f",
      "wav",
      out.file,
    ),
    { signal: ctx.signal },
  );
}

function sourceOf(c: ClipSource, file: string): RenderInput["source"] {
  return { path: file, sampleRate: c.sampleRate, channels: c.channels, plainMono: c.plainMono };
}

export type RenderResult =
  | { status: "rendered"; clips: number; bytes: number; peakDb: number | null }
  | { status: "ingest"; reason: string }
  | { status: "skipped"; reason: string };

/** Whether this attempt is the job's last one (a failure then fails the session). */
function lastAttempt(db: Db, jobId: string): boolean {
  const job = getJob(db, jobId);
  return !job || job.attempts >= job.maxAttempts;
}

export const audioRenderHandler: JobHandler<RenderPayload, RenderResult> = {
  type: RENDER_JOB_TYPE,
  capability: RENDER_JOB_TYPE,
  payloadSchema: RenderPayloadSchema,
  async run(ctx, payload) {
    const { db } = ctx;
    const render = getEditRender(db, payload.renderId);
    if (!render) return { status: "skipped", reason: "render gone" };
    if (render.status === "done" || render.status === "skipped")
      return { status: "skipped", reason: render.status };
    const session = getEditSessionRow(db, payload.sessionId);
    if (!session || session.status !== "applying") {
      setRenderStatus(db, render.id, { status: "skipped" });
      return { status: "skipped", reason: "session not applying" };
    }
    try {
      return await renderOne(ctx, payload, render.id);
    } catch (err) {
      const permanent = err instanceof PermanentJobError;
      if (permanent || lastAttempt(db, ctx.jobId)) {
        const message = err instanceof Error ? err.message : String(err);
        const failed = failEditSession(db, payload.sessionId, render.id, message);
        if (failed) emitSession(ctx, failed.id);
      }
      throw err;
    }
  },
};

/** `edit.changed` for the session's song (render progress, status). */
function emitSession(ctx: Pick<JobContext, "db" | "emit">, sessionId: string): void {
  const s = getEditSessionRow(ctx.db, sessionId);
  if (!s) return;
  ctx.emit({
    type: "edit.changed",
    projectId: s.projectId,
    songId: s.songId,
    data: { songId: s.songId, sessionId: s.id, status: s.status, rev: s.rev },
  });
}

async function renderOne(
  ctx: JobContext,
  payload: RenderPayload,
  renderId: string,
): Promise<RenderResult> {
  const { db, tools } = ctx;
  const render = getEditRender(db, renderId);
  if (!render?.assetId || !render.versionId) throw new PermanentJobError("Render without asset");
  const asset = getAsset(db, render.assetId);
  if (!asset) throw new PermanentJobError(`Asset ${render.assetId} not found`);
  db.update(editRenders)
    .set({ status: "running", attempts: render.attempts + 1, updatedAt: Date.now() })
    .where(eq(editRenders.id, render.id))
    .run();
  emitSession(ctx, payload.sessionId);
  const assetId = asset.id;
  const versionId = render.versionId;
  const ingest = () => {
    setAssetStatus(db, assetId, "queued");
    enqueueAudioIngest(db, {
      assetId,
      projectId: payload.projectId,
      songId: payload.songId,
      trackVersionId: versionId,
      createdBy: asset.uploadedBy,
    });
    setRenderStatus(db, render.id, { status: "done", error: null });
    emitSession(ctx, payload.sessionId);
  };
  // Rendered before (interrupted after storing it, or the ingest failed): only the ingest.
  if (getVariant(db, assetId, "original")) {
    ingest();
    return { status: "ingest", reason: "already rendered" };
  }
  setAssetStatus(db, assetId, "processing");
  const clips = renderClips(render);
  const inputs: RenderInput[] = [];
  const sources: ClipSource[] = [];
  for (const clip of clips) {
    const src = resolveClipSource(db, clip.sourceVersionId);
    if (!src)
      throw new PermanentJobError(
        `${RENDER_SOURCE_MISSING}: the file of version ${clip.sourceVersionId} is gone`,
      );
    sources.push(src);
    const file = await ctx.input({ assetId: src.asset.id, variant: src.variant });
    inputs.push({ source: sourceOf(src, file), clip });
  }
  const channels = renderChannels(inputs);
  if (channels !== outputChannels(sources)) throw new Error("unreachable: channel rules differ");
  const span = renderSpan(clips);
  const lengthSec = span.length / RENDER_RATE;
  const signal = withTimeLimit(ctx.signal, mediaTimeLimitMs(lengthSec * 2));
  ctx.progress(0.05, "render");
  const file = path.join(ctx.tmpDir, "render.wav");
  await renderInputs({ tools, tmpDir: ctx.tmpDir, signal }, inputs, {
    ...span,
    channels,
    file,
    codec: "pcm_s24le",
  });
  ctx.progress(0.7, "measure");
  const loudness = await measureLoudness(file, tools, signal);
  const probe = await probeAudio(file, tools, signal);
  const { size } = await fs.stat(file);
  // The real size against the quota, as an upload's finish does (SPEC §15.1).
  const user = asset.uploadedBy ? getUserById(db, asset.uploadedBy) : undefined;
  const quota = user ? quotaCheck(db, user, size) : { ok: true as const };
  if (!quota.ok)
    throw new PermanentJobError(
      `QUOTA_EXCEEDED: the render needs ${size} bytes, ${quota.remainingBytes} left`,
    );
  ctx.progress(0.9, "store");
  const hash = await ctx.output({ assetId, variant: "original" }, file, { size });
  db.update(assets)
    .set({ sizeBytes: size, originalHash: hash })
    .where(eq(assets.id, assetId))
    .run();
  setAssetProbe(db, assetId, {
    ...probe,
    loudness,
    ...(render.lossySource && { derivedFromLossy: true }),
  });
  const peakDb = loudness.truePeakDbtp;
  setRenderStatus(db, render.id, { peakDb });
  recordEvent(db, {
    actorType: "worker",
    actorUserId: asset.uploadedBy,
    action: "version.rendered",
    projectId: payload.projectId,
    songId: payload.songId,
    targetType: "trackVersion",
    targetId: render.versionId,
    details: {
      assetId,
      sessionId: payload.sessionId,
      renderId: render.id,
      clips: clips.length,
      bytes: size,
      peakDb,
      lossySource: render.lossySource,
    },
  });
  ingest();
  ctx.progress(1, "rendered");
  return { status: "rendered", clips: clips.length, bytes: size, peakDb };
}

export const EditCommitPayloadSchema = z.object({ sessionId: z.string() });
export type EditCommitPayload = z.infer<typeof EditCommitPayloadSchema>;

/**
 * `edit.commit` (SPEC §24.10 step 5): after a render's ingest settled, commits the session when
 * all renders are ready (or fails it when one failed). Idempotent: the commit is guarded.
 */
export const editCommitHandler: JobHandler<EditCommitPayload, { status: string }> = {
  type: EDIT_COMMIT_JOB_TYPE,
  capability: EDIT_COMMIT_JOB_TYPE,
  payloadSchema: EditCommitPayloadSchema,
  run(ctx, payload) {
    const result = commitEditSession(ctx.db, payload.sessionId);
    if (result.status === "committed") for (const e of result.events) ctx.emit(e);
    else if (result.status === "failed") emitSession(ctx, payload.sessionId);
    return Promise.resolve({ status: result.status });
  },
};
