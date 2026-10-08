import fs from "node:fs";
import path from "node:path";
import {
  AUDIO_QUALITIES,
  adminListApiKeys,
  adminListUsers,
  cancelAdminJob,
  cancelAdminUpdate,
  DEFAULT_AUDIO_QUALITY,
  getAdminEvents,
  getAdminJobs,
  getAdminLogs,
  getAdminStorage,
  getAdminSystem,
  getAdminUpdates,
  getAdminUploads,
  getWhoami,
  JOB_STATUSES,
  listProjects,
  listProjectSongs,
  listSongTracks,
  RELEASE_TAG_RE,
  requestAdminUpdate,
  retryAdminJob,
  type UploadOptions,
  type UploadTarget,
} from "@bandroom/shared";
import { RemoteError, sha256OfFile, type Client } from "./client";
import {
  checkSongTitles,
  CommandError,
  createProjectNamed,
  createSongTitled,
  describePlan,
  PartialFailureError,
  scanProjectFolder,
  scanSongFolder,
  uploadSong,
  waitForVersions,
  type Failure,
  type PlannedSong,
  type Skipped,
  type UploadedFile,
} from "./folders";
import { formatAgo, formatBytes, formatTime, parseSince, table } from "./format";

export interface Options {
  json: boolean;
  status?: string;
  type?: string;
  since?: string;
  action?: string;
  user?: string;
  project?: string;
  source?: string;
  level?: string;
  hours?: string;
  limit?: string;
  song?: string;
  track?: string;
  name?: string;
  confirm?: string;
  title?: string;
  description?: string;
  quality?: string;
  lossyOnly?: boolean;
  dryRun?: boolean;
  wait: boolean;
  /** Where relative file paths are resolved (the shell's cwd). */
  cwd: string;
}

export type Out = (text: string) => void;

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const LEVEL_NAMES: Record<number, string> = { 40: "WARN", 50: "ERROR", 60: "FATAL" };

function need(value: string | undefined, what: string): string {
  if (!value) throw new UsageError(`Missing ${what}`);
  return value;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], what: string) {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value))
    throw new UsageError(`${what} must be one of: ${allowed.join(", ")}`);
  return value as T;
}

export const USAGE = `brctl — BandRoom remote control (pnpm remote <command>)

Configuration: BANDROOM_URL and BANDROOM_API_KEY (environment or .env.remote in the repo root).
Add --json to any command for machine-readable output.

  whoami                         the key's user, scopes, server version and quota
  health                         /healthz
  status                         overview: system, health, jobs, backups, host, recent errors
  jobs [--status S] [--type T] [--limit N]
  jobs retry <id> | jobs cancel <id>
  events [--since 24h] [--action A] [--user ID] [--project ID] [--limit N]
  logs [--source app|worker|all] [--level warn|error|fatal] [--since 24h] [--limit N]
  storage                        usage and quota per user
  uploads [--hours 24]           recent track versions
  users                          users (admin)
  keys                           API keys (admin: all; otherwise this key)
  projects                       projects you can see
  songs <projectId>
  tracks <songId>
  find-song <title>
  upload <file> --song <id> (--track <id> | --name <name>) [UPLOAD OPTIONS]
  create-project <name> [--description D]      prints the new project's id
  create-song <projectId> <title>              prints the new song's id
  upload-song <folder> --project <id> [--title T] [UPLOAD OPTIONS] [--dry-run]
                                 a new song (titled after the folder) with one track per audio
                                 file in the folder; refuses a title the project already has
  upload-project <folder> [--project <id> | --name N] [UPLOAD OPTIONS] [--dry-run]
                                 a new project (named after the folder) unless --project; each
                                 subfolder with audio is a song, loose audio files one more song
                                 named after the folder
  update check | status | request <vX.Y.Z> | rollback --confirm <running> | cancel

Upload options: --quality veryHigh|high|standard|low (Opus preset), --lossy-only (keep only
Opus), --wait (until every version is ready or failed). Folder uploads send one file at a time,
name tracks like the web folder drop, skip non-audio files and zips (unzip them first), continue
after a failed file and exit non-zero listing the failures. --dry-run prints the plan only.`;

export async function run(client: Client, args: string[], o: Options, out: Out): Promise<void> {
  const [cmd, ...rest] = args;
  const print = (data: unknown, human: () => string) => {
    out(o.json ? JSON.stringify(data, null, 2) : human());
  };

  switch (cmd) {
    case "whoami": {
      const w = await client.call(getWhoami);
      print(w, () =>
        [
          `user:    ${w.user.displayName} (${w.user.username}, ${w.user.globalRole})`,
          `key:     ${w.key ? `${w.key.name} [${w.key.scopes.join(", ")}], expires ${w.key.expiresAt ? formatTime(w.key.expiresAt) : "never"}` : "-"}`,
          `server:  ${w.server.version}, max upload ${formatBytes(w.server.maxUploadBytes)}`,
          `storage: ${formatBytes(w.quota.usedBytes)} of ${w.quota.quotaBytes === null ? "unlimited" : formatBytes(w.quota.quotaBytes)}`,
        ].join("\n"),
      );
      return;
    }
    case "health": {
      const h = await client.health();
      print(h, () => `HTTP ${h.status}\n${JSON.stringify(h.body, null, 2)}`);
      return;
    }
    case "status":
      return status(client, o, out);
    case "jobs": {
      const [sub, id] = rest;
      if (sub === "retry" || sub === "cancel") {
        const contract = sub === "retry" ? retryAdminJob : cancelAdminJob;
        const r = await client.call(contract, { params: { id: need(id, "job id") } });
        print(r, () => `${r.job.id}: ${r.job.type} is now ${r.job.status}`);
        return;
      }
      if (sub !== undefined) throw new UsageError(`Unknown jobs subcommand "${sub}"`);
      const r = await client.call(getAdminJobs, {
        query: {
          status: oneOf(o.status, JOB_STATUSES, "--status"),
          type: o.type,
          limit: o.limit === undefined ? undefined : Number(o.limit),
        },
      });
      print(r, () =>
        [
          `counts: ${
            Object.entries(r.counts)
              .map(([k, v]) => `${k} ${v}`)
              .join(", ") || "none"
          }`,
          table(
            ["id", "type", "status", "try", "created", "finished", "error"],
            r.jobs.map((j) => [
              j.id,
              j.type,
              j.status,
              `${j.attempts}/${j.maxAttempts}`,
              formatTime(j.createdAt),
              formatTime(j.finishedAt),
              j.error,
            ]),
          ),
        ].join("\n"),
      );
      return;
    }
    case "events": {
      const r = await client.call(getAdminEvents, {
        query: {
          since: o.since === undefined ? undefined : parseSince(o.since),
          action: o.action,
          actorUserId: o.user,
          projectId: o.project,
          limit: o.limit === undefined ? undefined : Number(o.limit),
        },
      });
      print(r, () =>
        table(
          ["time", "actor", "action", "target", "key", "details"],
          r.events.map((e) => [
            formatTime(e.ts),
            e.actorName ?? e.actorType,
            e.action,
            e.targetType ? `${e.targetType}:${e.targetId ?? ""}` : null,
            e.apiKeyId ? "yes" : "",
            e.details === null ? null : JSON.stringify(e.details),
          ]),
          80,
        ),
      );
      return;
    }
    case "logs": {
      const r = await client.call(getAdminLogs, {
        query: {
          source: oneOf(o.source, ["app", "worker", "all"] as const, "--source"),
          level: oneOf(o.level, ["warn", "error", "fatal"] as const, "--level"),
          since: o.since === undefined ? undefined : parseSince(o.since),
          limit: o.limit === undefined ? undefined : Number(o.limit),
        },
      });
      print(r, () =>
        r.records.length === 0
          ? "No log records."
          : r.records
              .map((l) => {
                const {
                  level: _l,
                  time: _t,
                  msg: _m,
                  pid: _p,
                  hostname: _h,
                  name: _n,
                  ...rest
                } = l.raw;
                const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : "";
                return `${formatTime(l.time)} ${l.source} ${LEVEL_NAMES[l.level] ?? l.level} ${l.msg}${extra}`;
              })
              .join("\n"),
      );
      return;
    }
    case "storage": {
      const r = await client.call(getAdminStorage);
      print(r, () =>
        [
          `blobs ${formatBytes(r.totals.blobBytes)} (${r.totals.blobCount}), usage ${formatBytes(r.totals.usageBytes)}, disk free ${formatBytes(r.totals.diskFreeBytes)} of ${formatBytes(r.totals.diskTotalBytes)}`,
          table(
            ["user", "name", "used", "quota"],
            r.users.map((u) => [
              u.username,
              u.displayName,
              formatBytes(u.usedBytes),
              u.quotaBytes === null ? "unlimited" : formatBytes(u.quotaBytes),
            ]),
          ),
        ].join("\n"),
      );
      return;
    }
    case "uploads": {
      const r = await client.call(getAdminUploads, {
        query: { hours: o.hours === undefined ? undefined : Number(o.hours) },
      });
      print(r, () =>
        table(
          ["time", "project", "song", "track", "v", "by", "status", "size", "file"],
          r.uploads.map((u) => [
            formatTime(u.createdAt),
            u.projectName,
            u.songTitle,
            u.trackName,
            u.number,
            u.uploader,
            u.deleted ? `${u.status} (deleted)` : u.error ? `${u.status}: ${u.error}` : u.status,
            formatBytes(u.sizeBytes),
            u.filename,
          ]),
          40,
        ),
      );
      return;
    }
    case "users": {
      const r = await client.call(adminListUsers);
      print(r, () =>
        table(
          ["username", "name", "role", "disabled", "last seen", "used"],
          r.users.map((u) => [
            u.username,
            u.displayName,
            u.globalRole,
            u.disabledAt ? "yes" : "",
            formatAgo(u.lastSeenAt),
            formatBytes(u.usedBytes),
          ]),
        ),
      );
      return;
    }
    case "keys": {
      try {
        const r = await client.call(adminListApiKeys);
        print(r, () =>
          table(
            ["prefix", "name", "owner", "scopes", "last used", "expires"],
            r.keys.map((k) => [
              k.prefix,
              k.name,
              k.username,
              k.scopes.join(","),
              formatAgo(k.lastUsedAt),
              k.expiresAt ? formatTime(k.expiresAt) : "never",
            ]),
          ),
        );
      } catch (err) {
        if (
          !(err instanceof RemoteError) ||
          (err.code !== "API_KEY_SCOPE" && err.code !== "FORBIDDEN")
        )
          throw err;
        // Keys never list keys; without admin rights this key is all we can show.
        const w = await client.call(getWhoami);
        print({ keys: w.key ? [w.key] : [] }, () =>
          w.key ? `${w.key.name} [${w.key.scopes.join(", ")}]` : "No key.",
        );
      }
      return;
    }
    case "projects": {
      const r = await client.call(listProjects, { query: {} });
      print(r, () =>
        table(
          ["id", "name", "songs", "updated", "archived"],
          r.projects.map((p) => [
            p.id,
            p.name,
            p.songCount,
            formatTime(p.updatedAt),
            p.archivedAt ? "yes" : "",
          ]),
        ),
      );
      return;
    }
    case "songs": {
      const r = await client.call(listProjectSongs, {
        params: { id: need(rest[0], "project id") },
      });
      print(r, () =>
        table(
          ["id", "title", "subtitle", "updated"],
          r.songs.map((s) => [s.id, s.title, s.subtitle, formatTime(s.updatedAt)]),
        ),
      );
      return;
    }
    case "tracks": {
      const r = await client.call(listSongTracks, { params: { id: need(rest[0], "song id") } });
      print(r, () =>
        table(
          ["id", "name", "versions", "current", "status"],
          r.tracks.map((t) => [
            t.id,
            t.name,
            t.versionCount,
            t.current ? `v${t.current.number}` : null,
            t.current?.status,
          ]),
        ),
      );
      return;
    }
    case "find-song": {
      const needle = need(rest.join(" ").trim(), "title").toLowerCase();
      const { projects } = await client.call(listProjects, { query: {} });
      const found: { projectId: string; project: string; songId: string; title: string }[] = [];
      for (const p of projects) {
        const { songs } = await client.call(listProjectSongs, { params: { id: p.id } });
        for (const s of songs) {
          if (s.title.toLowerCase().includes(needle))
            found.push({ projectId: p.id, project: p.name, songId: s.id, title: s.title });
        }
      }
      print({ songs: found }, () =>
        found.length === 0
          ? "No matching song."
          : table(
              ["song id", "title", "project"],
              found.map((f) => [f.songId, f.title, f.project]),
            ),
      );
      return;
    }
    case "upload":
      return upload(client, rest, o, out);
    case "create-project": {
      const name = need(rest.join(" ").trim(), "project name");
      if (o.dryRun) {
        print({ dryRun: true, project: { name } }, () => `would create project "${name}"`);
        return;
      }
      const id = await createProjectNamed(client, name, o.description);
      print({ project: { id, name } }, () => id);
      return;
    }
    case "create-song": {
      const projectId = need(rest[0], "project id");
      const title = need(rest.slice(1).join(" ").trim(), "song title");
      if (o.dryRun) {
        print({ dryRun: true, song: { projectId, title } }, () => `would create song "${title}"`);
        return;
      }
      const id = await createSongTitled(client, projectId, title);
      print({ song: { id, projectId, title } }, () => id);
      return;
    }
    case "upload-song":
      return uploadFolder(client, "song", rest, o, out);
    case "upload-project":
      return uploadFolder(client, "project", rest, o, out);
    case "update":
      return update(client, rest, o, out);
    case undefined:
    case "help":
      out(USAGE);
      return;
    default:
      throw new UsageError(`Unknown command "${cmd}"`);
  }
}

async function status(client: Client, o: Options, out: Out): Promise<void> {
  const [system, health, jobs, logs, updates] = await Promise.all([
    client.call(getAdminSystem),
    client.health(),
    client.call(getAdminJobs, { query: { status: "failed", limit: 5 } }),
    client.call(getAdminLogs, {
      query: { level: "error", since: Date.now() - 86_400_000, limit: 10 },
    }),
    client.call(getAdminUpdates, { query: {} }),
  ]);
  const data = { system, health, failedJobs: jobs, recentErrors: logs.records, updates };
  if (o.json) {
    out(JSON.stringify(data, null, 2));
    return;
  }
  const h = health.body as { status?: string; checks?: Record<string, { ok: boolean }> };
  const failing = Object.entries(h.checks ?? {})
    .filter(([, c]) => !c.ok)
    .map(([k]) => k);
  const lines = [
    `version:  ${system.version} (node ${system.node}), up ${Math.round(system.uptimeSec / 3600)} h`,
    `health:   ${h.status ?? `HTTP ${health.status}`}${failing.length ? ` (failing: ${failing.join(", ")})` : ""}`,
    `memory:   rss ${formatBytes(system.rssBytes)}, load ${system.loadavg.map((l) => l.toFixed(2)).join(" ")}`,
    `disk:     ${formatBytes(system.disk?.freeBytes)} free of ${formatBytes(system.disk?.totalBytes)}; db ${formatBytes(system.dbBytes)}; blobs ${formatBytes(system.blobs.bytes)} (${system.blobs.count})`,
    `workers:  ${system.workers.map((w) => `${w.name} ${w.version ?? "?"} seen ${formatAgo(w.lastSeenAt)}`).join("; ") || "none"}`,
    `jobs:     ${
      Object.entries(jobs.counts)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ") || "none"
    }`,
    `backup:   ${system.backup ? JSON.stringify(system.backup) : "no status file"}`,
    `host:     ${system.hostStatus ? `status from ${formatAgo(typeof system.hostStatus.ts === "number" ? system.hostStatus.ts : null)}` : "no watcher status"}`,
    `update:   ${updates.request ? `${updates.request.action} ${updates.request.tag ?? ""} ${updates.request.state}` : "none pending"}${updates.lastResult ? `; last: ${updates.lastResult.action} ${updates.lastResult.tag ?? ""} exit ${updates.lastResult.exitCode}` : ""}`,
  ];
  if (jobs.jobs.length) {
    lines.push("", "recent failed jobs:");
    for (const j of jobs.jobs)
      lines.push(`  ${formatTime(j.finishedAt)} ${j.type} ${j.id}: ${j.error ?? ""}`);
  }
  lines.push("", `errors (24 h): ${logs.records.length === 0 ? "none" : ""}`);
  for (const l of logs.records) lines.push(`  ${formatTime(l.time)} ${l.source} ${l.msg}`);
  if (system.hostStatus)
    lines.push("", `host status: ${JSON.stringify(system.hostStatus, null, 2)}`);
  out(lines.join("\n"));
}

/** `--quality` / `--lossy-only` as tus target options; none for the defaults (SPEC §28.2). */
function uploadOptionsOf(o: Options): UploadOptions | undefined {
  const quality = oneOf(o.quality, AUDIO_QUALITIES, "--quality") ?? DEFAULT_AUDIO_QUALITY;
  const lossyOnly = o.lossyOnly === true;
  return lossyOnly || quality !== DEFAULT_AUDIO_QUALITY ? { lossyOnly, quality } : undefined;
}

async function upload(client: Client, rest: string[], o: Options, out: Out): Promise<void> {
  const file = path.resolve(o.cwd, need(rest[0], "file"));
  if (!fs.existsSync(file) || !fs.statSync(file).isFile())
    throw new UsageError(`Not a file: ${file}`);
  if (!o.track && !(o.song && o.name))
    throw new UsageError("upload needs --track <id>, or --song <id> with --name <name>");
  const options = uploadOptionsOf(o);
  let target: UploadTarget;
  if (o.track) {
    target = {
      type: "newVersion",
      trackId: o.track,
      sha256: await sha256OfFile(file),
      ...(options && { options }),
    };
  } else {
    target = {
      type: "newTrack",
      songId: need(o.song, "--song"),
      name: need(o.name, "--name"),
      ...(options && { options }),
    };
  }
  let lastPct = -1;
  const result = await client.upload(file, target, (sent, total) => {
    const pct = total === 0 ? 100 : Math.floor((sent / total) * 100);
    if (!o.json && pct !== lastPct && (pct === 100 || pct - lastPct >= 10)) {
      lastPct = pct;
      out(`uploaded ${pct}% (${formatBytes(sent)})`);
    }
  });
  let status: string | null = null;
  if (o.wait && result.trackId && result.trackVersionId) {
    const statuses = await waitForVersions(client, [
      { trackId: result.trackId, trackVersionId: result.trackVersionId },
    ]);
    status = statuses.get(result.trackVersionId) ?? null;
  }
  const data = { ...result, ...(status !== null && { status }) };
  out(
    o.json
      ? JSON.stringify(data, null, 2)
      : `track ${result.trackId ?? "-"}, version ${result.trackVersionId ?? "-"}${status ? `: ${status}` : " (processing; poll with: pnpm remote tracks <songId>)"}`,
  );
}

/** `upload-song` and `upload-project`: create the song(s) and upload a local folder. */
async function uploadFolder(
  client: Client,
  kind: "song" | "project",
  rest: string[],
  o: Options,
  out: Out,
): Promise<void> {
  const dir = path.resolve(o.cwd, need(rest[0], "folder"));
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
    throw new UsageError(`Not a folder: ${dir}`);
  const options = uploadOptionsOf(o);
  const log: Out = o.json ? () => undefined : out;

  let songs: PlannedSong[];
  let skipped: Skipped[];
  let projectId: string | null;
  let projectName: string | null = null;
  if (kind === "song") {
    projectId = need(o.project, "--project <id>");
    const scan = scanSongFolder(dir, dir);
    songs = [{ title: (o.title ?? path.basename(dir)).trim(), files: scan.files }];
    skipped = scan.skipped;
    if (scan.files.length === 0) {
      log(describePlan(projectId, [], skipped));
      throw new CommandError(`No audio files in ${dir}`);
    }
  } else {
    if (o.project && o.name) throw new UsageError("Use --project or --name, not both");
    projectId = o.project ?? null;
    if (!projectId) projectName = (o.name ?? path.basename(dir)).trim();
    ({ songs, skipped } = scanProjectFolder(dir));
    if (songs.length === 0) {
      log(describePlan(projectId ?? `new "${projectName}"`, [], skipped));
      throw new CommandError(`No audio files in ${dir} or its subfolders`);
    }
  }
  await checkSongTitles(
    client,
    projectId,
    songs.map((s) => s.title),
  );
  const projectLabel = projectId ?? `new "${projectName}"`;

  if (o.dryRun) {
    out(
      o.json
        ? JSON.stringify(
            {
              dryRun: true,
              project: { id: projectId, name: projectName },
              songs: songs.map((s) => ({
                title: s.title,
                tracks: s.files.map((f) => ({ file: f.file, name: f.name, bytes: f.bytes })),
              })),
              skipped,
            },
            null,
            2,
          )
        : `${describePlan(projectLabel, songs, skipped)}\n(dry run: nothing created or uploaded)`,
    );
    return;
  }

  let created = false;
  if (!projectId) {
    projectId = await createProjectNamed(client, projectName ?? path.basename(dir));
    created = true;
    log(`project "${projectName}" ${projectId}`);
  }
  const results: { id: string | null; title: string; tracks: UploadedFile[] }[] = [];
  const failures: Failure[] = [];
  for (const song of songs) {
    const r = await uploadSong(client, projectId, song, options, log);
    results.push({ id: r.songId, title: song.title, tracks: r.files });
    failures.push(...r.failures);
  }

  const uploaded = results.flatMap((r) => r.tracks).filter((t) => t.trackVersionId !== null);
  if (o.wait && uploaded.length > 0) {
    log(`waiting for ${uploaded.length} version(s) to be processed…`);
    const statuses = await waitForVersions(
      client,
      uploaded.flatMap((t) =>
        t.trackId && t.trackVersionId
          ? [{ trackId: t.trackId, trackVersionId: t.trackVersionId }]
          : [],
      ),
      { timeoutMs: 10 * 60_000 + uploaded.length * 60_000 },
    );
    for (const t of uploaded) {
      t.status = statuses.get(t.trackVersionId ?? "");
      if (t.status === "failed") failures.push({ file: t.file, error: "processing failed" });
    }
  }

  const statusCounts = new Map<string, number>();
  for (const t of uploaded)
    if (t.status) statusCounts.set(t.status, (statusCounts.get(t.status) ?? 0) + 1);
  const data = {
    project: { id: projectId, name: projectName, created },
    songs: results,
    skipped,
    failures,
  };
  out(
    o.json
      ? JSON.stringify(data, null, 2)
      : [
          `${uploaded.length} track(s) uploaded to ${results.filter((r) => r.id).length} song(s) in project ${projectId}${skipped.length ? `; ${skipped.length} skipped` : ""}`,
          ...(statusCounts.size
            ? [`status: ${[...statusCounts].map(([k, v]) => `${k} ${v}`).join(", ")}`]
            : o.wait
              ? []
              : ["processing; check with: pnpm remote songs " + projectId]),
        ].join("\n"),
  );
  if (failures.length > 0) throw new PartialFailureError(failures);
}

async function update(client: Client, rest: string[], o: Options, out: Out): Promise<void> {
  const [sub, arg] = rest;
  const show = (s: Awaited<ReturnType<typeof client.call<typeof getAdminUpdates>>>) => {
    out(
      o.json
        ? JSON.stringify(s, null, 2)
        : [
            `running:   ${s.running}`,
            `available: ${s.available ? s.available.slice(0, 10).join(" ") : "not checked (pnpm remote update check)"}${s.checkedAt ? ` (checked ${formatAgo(s.checkedAt)})` : ""}`,
            `request:   ${s.request ? `${s.request.action} ${s.request.tag ?? ""} by ${s.request.requestedBy}, ${s.request.state} since ${formatAgo(s.request.ts)}` : "none"}`,
            `last:      ${s.lastResult ? `${s.lastResult.action} ${s.lastResult.tag ?? ""} exit ${s.lastResult.exitCode} at ${formatTime(s.lastResult.finishedAt)}${s.lastResult.error ? ` (${s.lastResult.error})` : ""}` : "none"}`,
            `watcher:   ${s.hostStatusAt ? `last host status ${formatAgo(s.hostStatusAt)}` : "no host status yet (watcher installed?)"}`,
            ...(s.lastResult?.outputTail ? ["", "last output:", s.lastResult.outputTail] : []),
          ].join("\n"),
    );
  };
  switch (sub) {
    case "check":
      show(await client.call(getAdminUpdates, { query: { check: "true" } }));
      return;
    case "status":
    case undefined:
      show(await client.call(getAdminUpdates, { query: {} }));
      return;
    case "request": {
      const tag = need(arg, "tag (vX.Y.Z)");
      if (!RELEASE_TAG_RE.test(tag)) throw new UsageError("The tag must look like v1.2.3");
      const r = await client.call(requestAdminUpdate, { body: { action: "deploy", tag } });
      out(
        o.json
          ? JSON.stringify(r, null, 2)
          : `Requested deploy of ${tag} (${r.request.id}); watch with: pnpm remote update status`,
      );
      return;
    }
    case "rollback": {
      const confirm = need(o.confirm, "--confirm <running version>");
      const r = await client.call(requestAdminUpdate, {
        body: { action: "rollback", confirmRunningVersion: confirm },
      });
      out(
        o.json
          ? JSON.stringify(r, null, 2)
          : `Requested rollback from ${confirm} (${r.request.id})`,
      );
      return;
    }
    case "cancel": {
      const r = await client.call(cancelAdminUpdate);
      out(o.json ? JSON.stringify(r) : "Pending update request withdrawn.");
      return;
    }
    default:
      throw new UsageError(`Unknown update subcommand "${sub}"`);
  }
}
