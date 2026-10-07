import fs from "node:fs";
import path from "node:path";
import { uuidv7 } from "@bandroom/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertUser } from "../auth/users";
import { createProjectRow } from "../content/projects";
import { createSongRow } from "../content/songs";
import { listEvents } from "../events/record";
import { enqueueJob } from "../jobs/queue";
import { createAsset } from "../media/assets";
import { getUsage, putVariant, SYSTEM_USAGE_ID } from "../media/variants";
import { getSetting } from "../settings/registry";
import { getBlob } from "../storage/blobs";
import { makeTempDir } from "../testing/tempDir";
import { TEST_MIGRATIONS_DIR } from "../testing/testDb";
import { openDb, type Db } from "./connection";
import { convertMixTracks, hasColumn, migrateDatabase } from "./convertMixTracks";
import { runMigrations } from "./migrate";
import { blobs } from "./schema";

/** The migrations folder as of migration 0016 (before M21 dropped the mix columns). */
function migrationsUpTo(dir: string, lastIdx: number): string {
  const out = path.join(dir, `migrations-${lastIdx}`);
  fs.mkdirSync(path.join(out, "meta"), { recursive: true });
  const journal = JSON.parse(
    fs.readFileSync(path.join(TEST_MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
  ) as { entries: { idx: number; tag: string }[] };
  journal.entries = journal.entries.filter((e) => e.idx <= lastIdx);
  for (const e of journal.entries)
    fs.copyFileSync(path.join(TEST_MIGRATIONS_DIR, `${e.tag}.sql`), path.join(out, `${e.tag}.sql`));
  fs.writeFileSync(path.join(out, "meta", "_journal.json"), JSON.stringify(journal));
  return out;
}

let tmp: ReturnType<typeof makeTempDir>;
let db: Db;
let now = 1_000_000;

beforeEach(() => {
  tmp = makeTempDir();
  db = openDb(path.join(tmp.dir, "db.sqlite"));
  runMigrations(db, migrationsUpTo(tmp.dir, 16));
});
afterEach(() => {
  db.$client.close();
  tmp.cleanup();
});

const run = (sql: string, ...params: unknown[]) => db.$client.prepare(sql).run(...params);
const all = <T>(sql: string, ...params: unknown[]) => db.$client.prepare(sql).all(...params) as T[];

/** An asset (with an optional stored `opus` variant) uploaded by `uploadedBy`. */
function asset(uploadedBy: string | null, blobBytes = 0): { id: string; hash: string | null } {
  const a = createAsset(db, {
    kind: "audio",
    originalFilename: "x.wav",
    sizeBytes: 1,
    originalHash: uuidv7(),
    uploadedBy,
  });
  if (blobBytes === 0) return { id: a.id, hash: null };
  const hash = uuidv7().replaceAll("-", "");
  db.insert(blobs).values({ hash, sizeBytes: blobBytes, storageKey: hash, createdAt: 1 }).run();
  putVariant(db, a.id, "opus", hash, {}, now);
  return { id: a.id, hash };
}

/** A track with `versions` versions in the old schema (role and system flag). */
function track(
  songId: string,
  name: string,
  opts: { role?: "track" | "mix"; system?: boolean; uploadedBy: string | null; blobBytes?: number },
  versions = 1,
): { id: string; versionIds: string[]; assets: { id: string; hash: string | null }[] } {
  const id = uuidv7();
  run(
    `INSERT INTO tracks (id, song_id, name, role, is_system, sort_order, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    id,
    songId,
    name,
    opts.role ?? "track",
    opts.system ? 1 : 0,
    opts.uploadedBy,
    now,
  );
  const versionIds: string[] = [];
  const assets: { id: string; hash: string | null }[] = [];
  for (let n = 1; n <= versions; n++) {
    const a = asset(opts.uploadedBy, opts.blobBytes ?? 0);
    const vid = uuidv7();
    run(
      `INSERT INTO track_versions (id, track_id, number, stack_order, asset_id, source, is_auto_mix,
         uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      vid,
      id,
      n,
      n,
      a.id,
      opts.system ? "render" : "upload",
      opts.system ? 1 : 0,
      opts.uploadedBy,
      now,
    );
    versionIds.push(vid);
    assets.push(a);
  }
  run("UPDATE tracks SET current_version_id = ? WHERE id = ?", versionIds.at(-1), id);
  return { id, versionIds, assets };
}

function comment(songId: string, trackId: string | null, parentId: string | null = null): string {
  const id = uuidv7();
  run(
    `INSERT INTO comments (id, song_id, track_id, parent_id, body, created_at)
     VALUES (?, ?, ?, ?, 'hi', ?)`,
    id,
    songId,
    trackId,
    parentId,
    now,
  );
  return id;
}

function seed() {
  const admin = insertUser(db, {
    username: "admin",
    displayName: "A",
    passwordHash: "x",
    globalRole: "admin",
  }).id;
  const guest = insertUser(db, {
    username: "guest",
    displayName: "G",
    passwordHash: "x",
    globalRole: "guest",
  }).id;
  const project = createProjectRow(db, { name: "P", createdBy: admin }, now).id;
  const song = (title: string) =>
    createSongRow(db, { projectId: project, title, createdBy: admin }, now).id;

  // A stems song with an uploaded mix (two versions, a comment thread on it) and an auto-mix.
  const stems = song("Night Train");
  run("UPDATE songs SET download_policy = 'editors', subtitle = 'live' WHERE id = ?", stems);
  const bass = track(stems, "Bass", { uploadedBy: admin });
  const drums = track(stems, "Drums", { uploadedBy: admin });
  const mix = track(stems, "Mix", { role: "mix", uploadedBy: admin }, 2);
  const onMix = comment(stems, mix.id);
  const reply = comment(stems, null, onMix);
  const onBass = comment(stems, bass.id);
  const songWide = comment(stems, null);
  run(
    "INSERT INTO song_grants (song_id, user_id, role, granted_by, granted_at) VALUES (?, ?, 'commenter', ?, ?)",
    stems,
    guest,
    admin,
    now,
  );
  const autoMix = track(
    stems,
    "Auto mix",
    { role: "mix", system: true, uploadedBy: null, blobBytes: 1000 },
    2,
  );
  // An older auto-mix version already in the Trash (its files were released before).
  run("UPDATE track_versions SET deleted_at = ? WHERE id = ?", now, autoMix.versionIds[0]);

  // A song with only a mix track: left as it is.
  const single = song("Demo");
  const lone = track(single, "Mix", { role: "mix", uploadedBy: admin });

  // A deleted song with stems and a mix: not converted.
  const trashed = song("Old");
  track(trashed, "Bass", { uploadedBy: admin });
  const trashedMix = track(trashed, "Mix", { role: "mix", uploadedBy: admin });
  run("UPDATE songs SET deleted_at = ? WHERE id = ?", now, trashed);

  enqueueJob(db, {
    type: "audio.mixdown",
    capability: "audio.mixdown",
    payload: { songId: stems },
    dedupeKey: `mixdown:${stems}`,
  });

  return {
    admin,
    guest,
    project,
    stems,
    bass,
    drums,
    mix,
    onMix,
    reply,
    onBass,
    songWide,
    autoMix,
    single,
    lone,
    trashedMix,
  };
}

const songOf = (trackId: string) =>
  all<{ song_id: string }>("SELECT song_id FROM tracks WHERE id = ?", trackId)[0]?.song_id;

describe("convertMixTracks (SPEC §27.2)", () => {
  it("moves mix tracks, purges the automatic mix and drops the old columns", () => {
    const s = seed();
    const blobHash = s.autoMix.assets[0]?.hash ?? "";
    expect(getBlob(db, blobHash)?.refCount).toBe(1);
    expect(getUsage(db, SYSTEM_USAGE_ID)).toBe(2000);

    now += 1000;
    const r = migrateDatabase(db, TEST_MIGRATIONS_DIR, now);
    expect(r.conversion).toEqual({ movedTracks: 1, autoMixTracks: 1, cancelledJobs: 1 });
    expect(r.purgedAutoMixes).toBe(1);

    // The stems song keeps its stems.
    expect(songOf(s.bass.id)).toBe(s.stems);
    expect(songOf(s.drums.id)).toBe(s.stems);

    // The mix moved with both versions into "Night Train (mix)", after the other songs.
    const target = songOf(s.mix.id) ?? "";
    expect(target).not.toBe(s.stems);
    const song = all<{
      title: string;
      subtitle: string;
      project_id: string;
      download_policy: string;
      created_by: string;
    }>("SELECT * FROM songs WHERE id = ?", target)[0];
    expect(song).toMatchObject({
      title: "Night Train (mix)",
      subtitle: "live",
      project_id: s.project,
      download_policy: "editors",
      created_by: s.admin,
    });
    expect(
      all<{ id: string }>("SELECT id FROM track_versions WHERE track_id = ?", s.mix.id).map(
        (v) => v.id,
      ),
    ).toEqual(s.mix.versionIds);

    // The thread on the mix track went along; other comments stayed.
    const commentSong = (id: string) =>
      all<{ song_id: string }>("SELECT song_id FROM comments WHERE id = ?", id)[0]?.song_id;
    expect(commentSong(s.onMix)).toBe(target);
    expect(commentSong(s.reply)).toBe(target);
    expect(commentSong(s.onBass)).toBe(s.stems);
    expect(commentSong(s.songWide)).toBe(s.stems);

    // Same visibility: the guest's song grant was copied.
    expect(
      all<{ user_id: string; role: string }>(
        "SELECT user_id, role FROM song_grants WHERE song_id = ?",
        target,
      ),
    ).toEqual([{ user_id: s.guest, role: "commenter" }]);

    // The mix-only song and the deleted song are untouched.
    expect(songOf(s.lone.id)).toBe(s.single);
    expect(songOf(s.trashedMix.id)).not.toBe(target);

    // The automatic mix is gone, with its versions; its blob reference and usage are released.
    expect(all("SELECT id FROM tracks WHERE id = ?", s.autoMix.id)).toEqual([]);
    expect(all("SELECT id FROM track_versions WHERE track_id = ?", s.autoMix.id)).toEqual([]);
    expect(all("SELECT id FROM assets WHERE id = ?", s.autoMix.assets[1]?.id)).toEqual([]);
    expect(getBlob(db, blobHash)?.refCount).toBe(0);
    expect(getUsage(db, SYSTEM_USAGE_ID)).toBe(0);
    expect(getSetting(db, "migration.purgeTracks")).toEqual([]);

    // Queued mixdowns were cancelled.
    expect(all("SELECT status FROM jobs WHERE type = 'audio.mixdown'")).toEqual([
      { status: "cancelled" },
    ]);

    // Events by the system actor.
    const created = listEvents(db, { action: "song.created", targetId: target });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ actorType: "system", projectId: s.project });
    expect(JSON.parse(created[0]?.details ?? "{}")).toMatchObject({ sourceSongId: s.stems });
    expect(listEvents(db, { action: "track.moved", targetId: s.mix.id })[0]).toMatchObject({
      actorType: "system",
      songId: target,
    });
    expect(listEvents(db, { action: "grant.changed", targetId: s.guest })).toHaveLength(1);
    expect(listEvents(db, { action: "track.purged", targetId: s.autoMix.id })[0]).toMatchObject({
      actorType: "system",
    });

    // Migration 0017 dropped the columns.
    expect(hasColumn(db.$client, "tracks", "role")).toBe(false);
    expect(hasColumn(db.$client, "tracks", "is_system")).toBe(false);
    expect(hasColumn(db.$client, "track_versions", "is_auto_mix")).toBe(false);
    expect(hasColumn(db.$client, "public_links", "content")).toBe(false);

    // A second run changes nothing.
    const songs = all("SELECT id, title FROM songs ORDER BY id");
    const events = all("SELECT id FROM events").length;
    expect(migrateDatabase(db, TEST_MIGRATIONS_DIR, now + 1000)).toEqual({
      conversion: null,
      purgedAutoMixes: 0,
    });
    expect(all("SELECT id, title FROM songs ORDER BY id")).toEqual(songs);
    expect(all("SELECT id FROM events")).toHaveLength(events);
  });

  it("is idempotent before the migrations too, and numbers a second mix track", () => {
    const s = seed();
    const second = track(s.stems, "Mix B", { role: "mix", uploadedBy: s.admin });
    expect(convertMixTracks(db, now)).toMatchObject({ movedTracks: 2 });
    const titles = () =>
      all<{ title: string }>("SELECT title FROM songs ORDER BY title").map((r) => r.title);
    expect(titles()).toEqual([
      "Demo",
      "Night Train",
      "Night Train (mix 2)",
      "Night Train (mix)",
      "Old",
    ]);
    expect(songOf(second.id)).not.toBe(songOf(s.mix.id));
    const songs = titles();
    expect(convertMixTracks(db, now)).toMatchObject({ movedTracks: 0, cancelledJobs: 0 });
    expect(titles()).toEqual(songs);
  });
});
