import path from "node:path";
import {
  addTrackVersion,
  createOriginalAsset,
  createDocumentWithVersion,
  enqueueDocumentIngest,
  createProjectRow,
  createSongRow,
  createTrackWithVersion,
  enqueueAudioIngest,
  PermanentJobError,
  recordEvent,
  setAssetStatus,
  storeFile,
  updateTrackVersion,
  type Db,
  type JobContext,
} from "@bandroom/server-core";
import type { ImportNode, ImportProject, ImportVersion } from "@bandroom/shared";
import type { SamplyClient } from "./api";
import { importArtwork } from "./artwork";
import { importComments } from "./comments";
import {
  computeTotals,
  documentKind,
  planProject,
  stripExtension,
  validateMapping,
  type PlannedSong,
  type ProjectPlan,
} from "./mapping";
import { Reporter } from "./report";
import {
  Cancelled,
  checkCancelled,
  emitRun,
  finish,
  IMPORT_JOB_PRIORITY,
  ImportDiskFull,
} from "./runState";
import {
  liveLocal,
  liveLocalOfRun,
  recordMapping,
  runMapping,
  updateRun,
  type ExternalType,
  type ImportRunRow,
  type LocalType,
} from "./store";
import { orderedPool, paletteFromHex } from "./util";

/** State of one run, shared by the per-project steps. */
interface RunContext {
  ctx: JobContext;
  db: Db;
  run: ImportRunRow;
  client: SamplyClient;
  concurrency: number;
  dry: boolean;
  admin: string;
  rep: Reporter;
  /** Imported bytes so far (drives the progress). */
  doneBytes: number;
  tick: (note: string) => void;
  map: (
    externalType: ExternalType,
    externalId: string,
    localType: LocalType,
    localId: string,
  ) => void;
  /** The live local entity for an external item, and whether this run (an earlier attempt) made it. */
  found: (
    externalType: ExternalType,
    externalId: string,
    localType: LocalType,
  ) => { id: string; thisRun: boolean } | null;
}

/** A found item is "existing" only when an earlier run made it, not a failed attempt of this run. */
const foundOutcome = (found: { thisRun: boolean }) => (found.thisRun ? "imported" : "existing");

/** One included project: its plan and the local ids known or created so far. */
interface ProjectContext {
  project: ImportProject;
  projectId: string | null;
  plan: ProjectPlan;
  songIds: Map<string, string | null>;
  trackIds: Map<string, string | null>;
  songsBefore: Set<string>;
  tracksBefore: Set<string>;
  versionLocal: Map<string, { trackId: string; versionId: string }>;
  ensureSong: (song: PlannedSong) => string | null;
}

interface VersionTask {
  song: PlannedSong;
  trackIndex: number;
  version: ImportVersion;
}

export async function execute(
  ctx: JobContext,
  run: ImportRunRow,
  client: SamplyClient,
  concurrency: number,
): Promise<void> {
  const { db } = ctx;
  const mapping = runMapping(run);
  if (!mapping) throw new PermanentJobError("The run has no mapping");
  const errors = validateMapping(mapping);
  if (errors.length) throw new PermanentJobError(`Invalid mapping: ${errors.join("; ")}`);
  const dry = run.dryRun;
  const admin = run.createdBy;
  if (!admin) throw new PermanentJobError("The importing admin no longer exists");
  const rep = new Reporter(dry);
  const totalBytes = Math.max(1, computeTotals(mapping).bytes);
  const rc: RunContext = {
    ctx,
    db,
    run,
    client,
    concurrency,
    dry,
    admin,
    rep,
    doneBytes: 0,
    tick: (note) => {
      const progress = Math.min(0.99, rc.doneBytes / totalBytes);
      updateRun(db, run.id, { progress, report: rep.report });
      ctx.progress(progress, note);
      emitRun(ctx, run.id, { note });
    },
    map: (externalType, externalId, localType, localId) => {
      if (!dry) recordMapping(db, { externalType, externalId, localType, localId, runId: run.id });
    },
    found: (externalType, externalId, localType) =>
      liveLocalOfRun(db, externalType, externalId, localType, run.id),
  };

  updateRun(db, run.id, { status: "running", progress: 0, error: null, report: rep.report });
  recordEvent(db, {
    action: "import.started",
    actorUserId: admin,
    targetType: "import",
    targetId: run.id,
    details: { dryRun: dry, projects: mapping.projects.filter((p) => p.include).length },
  });
  emitRun(ctx, run.id);

  for (const project of mapping.projects.filter((p) => p.include)) {
    checkCancelled(ctx, run.id);
    rep.log(`Project ${project.name}`);
    const projectId = importProjectRow(rc, project);
    if (projectId && !dry) await importArtwork(ctx, client, project, projectId, admin, rep);

    const pc = planContext(rc, project, projectId);
    await importVersions(rc, pc);
    reportTrackOutcomes(rc, pc);
    await importDocuments(rc, pc);
    reportSongOutcomes(rc, pc);
    await importVersionComments(rc, pc);
    if (mapping.includeInsights && projectId) await importInsights(rc, project, projectId);
  }

  updateRun(db, run.id, { progress: 1 });
  // A dry run goes back to review (key kept) so the real run can follow.
  finish(ctx, run.id, dry ? "review" : "done", null, rep.report);
}

/** The project row: found from an earlier run, planned (dry run) or created. */
function importProjectRow(rc: RunContext, project: ImportProject): string | null {
  const { db, rep, admin, run } = rc;
  const found = rc.found("project", project.samplyId, "project");
  if (found) {
    rep.item({ kind: "project", name: project.name, outcome: foundOutcome(found), reason: null });
    return found.id;
  }
  if (rc.dry) {
    rep.item({ kind: "project", name: project.name, outcome: "planned", reason: null });
    return null;
  }
  const created = createProjectRow(db, {
    name: project.name.slice(0, 120) || "Samply project",
    color: paletteFromHex(project.color),
    createdBy: admin,
  });
  rc.map("project", project.samplyId, "project", created.id);
  recordEvent(db, {
    action: "project.created",
    actorUserId: admin,
    projectId: created.id,
    targetType: "project",
    targetId: created.id,
    details: { name: project.name, imported: true, source: "samply", runId: run.id },
  });
  rc.ctx.emit({ type: "project.updated", projectId: created.id, data: { projectId: created.id } });
  rep.item({ kind: "project", name: project.name, outcome: "imported", reason: null });
  return created.id;
}

function planContext(
  rc: RunContext,
  project: ImportProject,
  projectId: string | null,
): ProjectContext {
  const { db, admin } = rc;
  const plan = planProject(project);
  // Existing songs/tracks from earlier runs; new songs are created on their first new content,
  // so a song whose items were all imported elsewhere never ends up empty.
  const songIds = new Map<string, string | null>();
  const trackIds = new Map<string, string | null>();
  const songsBefore = new Set<string>();
  const tracksBefore = new Set<string>();
  for (const song of plan.songs) {
    const existing = rc.found("box", song.node.id, "song");
    songIds.set(song.node.id, existing?.id ?? null);
    if (existing && !existing.thisRun) songsBefore.add(song.node.id);
    for (const t of song.tracks) {
      const track = rc.found("box", t.node.id, "track");
      trackIds.set(t.node.id, track?.id ?? null);
      if (track && !track.thisRun) tracksBefore.add(t.node.id);
    }
  }
  const ensureSong = (song: PlannedSong): string | null => {
    const have = songIds.get(song.node.id);
    if (have) return have;
    if (rc.dry || !projectId) return null;
    const songId = createSongRow(db, {
      projectId,
      title: song.title.slice(0, 200),
      createdBy: admin,
    }).id;
    songIds.set(song.node.id, songId);
    rc.map("box", song.node.id, "song", songId);
    recordEvent(db, {
      action: "song.created",
      actorUserId: admin,
      projectId,
      songId,
      targetType: "song",
      targetId: songId,
      details: { title: song.title, imported: true, source: "samply" },
    });
    // Members see imported songs appear live (SPEC §25.3).
    rc.ctx.emit({ type: "song.created", projectId, songId, data: { songId } });
    return songId;
  };
  return {
    project,
    projectId,
    plan,
    songIds,
    trackIds,
    songsBefore,
    tracksBefore,
    versionLocal: new Map(),
    ensureSong,
  };
}

/** Track versions: downloads overlap, commits follow the stack order. */
async function importVersions(rc: RunContext, pc: ProjectContext): Promise<void> {
  const { ctx, db, run, client, dry, admin, rep } = rc;
  const { project, projectId, plan, trackIds, versionLocal } = pc;
  const tasks: VersionTask[] = plan.songs.flatMap((song) =>
    song.tracks.flatMap((t, trackIndex) =>
      t.node.versions.map((version) => ({ song, trackIndex, version })),
    ),
  );
  await orderedPool(
    tasks,
    rc.concurrency,
    async (task) => {
      if (task.version.imported || dry) return null;
      checkCancelled(ctx, run.id);
      const { url } = await client.downloadUrl(project.samplyId, task.version.id);
      const dest = path.join(ctx.tmpDir, `${task.version.id}.bin`);
      return { dest, ...(await client.download(url, dest)) };
    },
    async (task, result) => {
      const track = task.song.tracks[task.trackIndex];
      if (!track) return;
      const name = `${task.song.title} / ${track.name} / ${stripExtension(task.version.name)}`;
      const existing = rc.found("file", task.version.id, "trackVersion");
      if (existing) {
        const trackId = trackIds.get(track.node.id);
        if (trackId) versionLocal.set(task.version.id, { trackId, versionId: existing.id });
        rep.item({ kind: "version", name, outcome: foundOutcome(existing), reason: null });
        return;
      }
      if (dry) {
        rep.item({ kind: "version", name, outcome: "planned", reason: null });
        return;
      }
      if (result.status === "rejected" || !result.value) {
        const reason = result.status === "rejected" ? String(result.reason) : "no data";
        if (
          result.status === "rejected" &&
          (result.reason instanceof Cancelled || result.reason instanceof ImportDiskFull)
        )
          throw result.reason;
        rep.item({ kind: "version", name, outcome: "failed", reason: reason.slice(0, 300) });
        rep.log(`Failed: ${name}: ${reason.slice(0, 200)}`);
        return;
      }
      const songId = pc.ensureSong(task.song);
      if (!songId || !projectId) return;
      const dl = result.value;
      const blob = await storeFile(db, ctx.storage, dl.dest, dl.sha256);
      const asset = createOriginalAsset(
        db,
        {
          kind: "audio",
          originalFilename: task.version.name,
          mimeType: dl.contentType ?? undefined,
          sizeBytes: dl.sizeBytes,
          originalHash: dl.sha256,
          uploadedBy: admin,
        },
        blob,
      );
      let trackId = trackIds.get(track.node.id) ?? null;
      let versionId: string;
      if (!trackId) {
        const created = createTrackWithVersion(db, {
          songId,
          name: track.name,
          assetId: asset.id,
          uploadedBy: admin,
          source: "import",
        });
        trackId = created.track.id;
        versionId = created.version.id;
        trackIds.set(track.node.id, trackId);
        rc.map("box", track.node.id, "track", trackId);
      } else {
        versionId = addTrackVersion(db, {
          trackId,
          assetId: asset.id,
          uploadedBy: admin,
          source: "import",
        }).id;
      }
      updateTrackVersion(db, versionId, {
        label: stripExtension(task.version.name).slice(0, 100),
        notes: "Imported from Samply",
      });
      rc.map("file", task.version.id, "trackVersion", versionId);
      versionLocal.set(task.version.id, { trackId, versionId });
      setAssetStatus(db, asset.id, "queued");
      enqueueAudioIngest(db, {
        assetId: asset.id,
        projectId,
        songId,
        trackVersionId: versionId,
        createdBy: admin,
        priority: IMPORT_JOB_PRIORITY,
      });
      recordEvent(db, {
        action: "version.uploaded",
        actorUserId: admin,
        projectId,
        songId,
        targetType: "trackVersion",
        targetId: versionId,
        details: { name: task.version.name, imported: true, source: "samply" },
      });
      ctx.emit({
        type: "version.created",
        projectId,
        songId,
        data: { assetId: asset.id, trackId, trackVersionId: versionId },
      });
      rc.doneBytes += dl.sizeBytes;
      rep.item({ kind: "version", name, outcome: "imported", reason: null });
      rc.tick(name);
    },
  );
}

function reportTrackOutcomes(rc: RunContext, pc: ProjectContext): void {
  for (const song of pc.plan.songs) {
    for (const t of song.tracks) {
      const name = `${song.title} / ${t.name}`;
      const outcome = pc.tracksBefore.has(t.node.id)
        ? "existing"
        : pc.trackIds.get(t.node.id)
          ? "imported"
          : rc.dry
            ? "planned"
            : "failed";
      rc.rep.item({
        kind: "track",
        name,
        outcome,
        reason: outcome === "failed" ? "no version imported" : null,
      });
    }
  }
}

/** Documents (song-level and project-level). */
async function importDocuments(rc: RunContext, pc: ProjectContext): Promise<void> {
  const { ctx, db, run, client, dry, admin, rep } = rc;
  const { project, projectId, plan } = pc;
  const docTargets: { node: ImportNode; song: PlannedSong | null }[] = [
    ...plan.songs.flatMap((song) => song.documents.map((node) => ({ node, song }))),
    ...plan.projectDocuments.map((node) => ({ node, song: null })),
  ];
  for (const d of docTargets) {
    checkCancelled(ctx, run.id);
    for (const v of d.node.versions) {
      const name = d.song ? `${d.song.title} / ${v.name}` : v.name;
      const existing = rc.found("file", v.id, "document");
      if (existing) {
        rep.item({ kind: "document", name, outcome: foundOutcome(existing), reason: null });
        continue;
      }
      if (dry || !projectId) {
        rep.item({ kind: "document", name, outcome: "planned", reason: null });
        continue;
      }
      try {
        const { url } = await client.downloadUrl(project.samplyId, v.id);
        const dest = path.join(ctx.tmpDir, `${v.id}.doc`);
        const dl = await client.download(url, dest);
        const blob = await storeFile(db, ctx.storage, dest, dl.sha256);
        const asset = createOriginalAsset(
          db,
          {
            kind: "document",
            originalFilename: v.name,
            mimeType: dl.contentType ?? undefined,
            sizeBytes: dl.sizeBytes,
            originalHash: dl.sha256,
            uploadedBy: admin,
          },
          blob,
        );
        const songIdOfDoc = d.song ? pc.ensureSong(d.song) : null;
        const { document, version } = createDocumentWithVersion(db, {
          projectId,
          songId: songIdOfDoc,
          title: stripExtension(v.name),
          kind: documentKind(v.name),
          assetId: asset.id,
          createdBy: admin,
          source: "import",
        });
        // Kind by content and previews (SPEC §5.7), below interactive uploads.
        enqueueDocumentIngest(db, {
          assetId: asset.id,
          documentId: document.id,
          documentVersionId: version.id,
          projectId,
          songId: songIdOfDoc,
          createdBy: admin,
          priority: IMPORT_JOB_PRIORITY,
        });
        rc.map("file", v.id, "document", document.id);
        rc.doneBytes += dl.sizeBytes;
        rep.item({ kind: "document", name, outcome: "imported", reason: null });
        rc.tick(name);
      } catch (err) {
        if (err instanceof Cancelled || err instanceof ImportDiskFull || ctx.signal.aborted)
          throw err;
        rep.item({
          kind: "document",
          name,
          outcome: "failed",
          reason: String(err).slice(0, 300),
        });
      }
    }
  }
}

function reportSongOutcomes(rc: RunContext, pc: ProjectContext): void {
  for (const song of pc.plan.songs) {
    const hasNew =
      song.tracks.some((t) => t.node.versions.some((v) => !v.imported)) ||
      song.documents.some((d) => d.versions.some((v) => !v.imported));
    const outcome = pc.songsBefore.has(song.node.id)
      ? "existing"
      : pc.songIds.get(song.node.id)
        ? "imported"
        : rc.dry && hasNew
          ? "planned"
          : "skipped";
    rc.rep.item({
      kind: "song",
      name: song.title,
      outcome,
      reason: outcome === "skipped" ? "nothing new to import" : null,
    });
  }
}

/** Comments on every mapped version (new ones only; replies after their parents). */
async function importVersionComments(rc: RunContext, pc: ProjectContext): Promise<void> {
  const { ctx, run, client, dry, rep } = rc;
  for (const song of pc.plan.songs) {
    const songId = pc.songIds.get(song.node.id) ?? null;
    for (const track of song.tracks) {
      for (const v of track.node.versions) {
        if (v.commentCount === 0) continue;
        checkCancelled(ctx, run.id);
        const local = pc.versionLocal.get(v.id);
        const list = await client.listComments(pc.project.samplyId, v.id);
        importComments(ctx, run.id, rep, list, {
          dry,
          songId,
          trackId: local?.trackId ?? null,
          context: local ? { trackVersions: { [local.trackId]: local.versionId } } : {},
          songTitle: song.title,
        });
      }
    }
  }
}

async function importInsights(
  rc: RunContext,
  project: ImportProject,
  projectId: string,
): Promise<void> {
  const { ctx, db, run, client, dry, rep } = rc;
  checkCancelled(ctx, run.id);
  const insights = await client.listInsights(project.samplyId);
  const fresh = insights.filter((i) => !liveLocal(db, "insight", i.id, "event"));
  for (const i of fresh) {
    if (dry) continue;
    recordEvent(db, {
      action: "import.insight",
      actorType: "system",
      projectId,
      targetType: "project",
      targetId: projectId,
      ts: i.timeCreated ?? Date.now(),
      details: {
        imported: true,
        source: "samply",
        type: i.type,
        completion: i.completion ?? null,
        country: i.country ?? null,
        userName: i.userName ?? null,
      },
    });
    rc.map("insight", i.id, "event", i.id);
  }
  rep.item({
    kind: "insight",
    name: `${project.name}: ${fresh.length} insights`,
    outcome: dry ? "planned" : "imported",
    reason: null,
  });
}
