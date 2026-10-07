import path from "node:path";
import { uuidv7 } from "@bandroom/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertUser } from "../auth/users";
import { createProjectRow } from "../content/projects";
import { createSongRow } from "../content/songs";
import { listEvents } from "../events/record";
import { getUsage, putVariant } from "../media/variants";
import { getSetting } from "../settings/registry";
import { getBlob } from "../storage/blobs";
import { migrationIndex, migrationsUpTo } from "../testing/migrationsUpTo";
import { makeTempDir } from "../testing/tempDir";
import { TEST_MIGRATIONS_DIR } from "../testing/testDb";
import { openDb, type Db } from "./connection";
import { hasColumn, migrateDatabase } from "./convertMixTracks";
import { dropSongDocuments } from "./dropSongDocuments";
import { runMigrations } from "./migrate";
import { blobs } from "./schema";

let tmp: ReturnType<typeof makeTempDir>;
let db: Db;
const now = 2_000_000;

beforeEach(() => {
  tmp = makeTempDir();
  db = openDb(path.join(tmp.dir, "db.sqlite"));
  // The schema just before documents lost `song_id`.
  runMigrations(db, migrationsUpTo(tmp.dir, migrationIndex("drop_song_documents") - 1));
});
afterEach(() => {
  db.$client.close();
  tmp.cleanup();
});

const run = (sql: string, ...params: unknown[]) => db.$client.prepare(sql).run(...params);
const all = <T>(sql: string, ...params: unknown[]) => db.$client.prepare(sql).all(...params) as T[];

function blob(size: number): string {
  const hash = uuidv7().replaceAll("-", "");
  db.insert(blobs).values({ hash, sizeBytes: size, storageKey: hash, createdAt: 1 }).run();
  return hash;
}

/** A document (old schema) with one version whose asset stores the given blobs. */
function doc(
  projectId: string,
  songId: string | null,
  title: string,
  uploadedBy: string,
  hashes: string[],
  deleted = false,
): { id: string; assetId: string } {
  // Raw SQL: the schema here predates later asset columns (0019 ingest_options).
  const a = { id: uuidv7() };
  run(
    `INSERT INTO assets (id, kind, original_filename, size_bytes, original_hash, status,
       uploaded_by, created_at) VALUES (?, 'document', ?, 1, ?, 'queued', ?, ?)`,
    a.id,
    `${title}.pdf`,
    uuidv7(),
    uploadedBy,
    now,
  );
  hashes.forEach((h, i) => {
    putVariant(db, a.id, i === 0 ? "original" : `page${String(i)}`, h, {}, now);
  });
  const id = uuidv7();
  run(
    `INSERT INTO documents (id, project_id, song_id, title, kind, created_by, created_at, deleted_at)
     VALUES (?, ?, ?, ?, 'pdf', ?, ?, ?)`,
    id,
    projectId,
    songId,
    title,
    uploadedBy,
    now,
    deleted ? now : null,
  );
  const vid = uuidv7();
  run(
    `INSERT INTO document_versions (id, document_id, number, asset_id, uploaded_by, created_at)
     VALUES (?, ?, 1, ?, ?, ?)`,
    vid,
    id,
    a.id,
    uploadedBy,
    now,
  );
  run("UPDATE documents SET current_version_id = ? WHERE id = ?", vid, id);
  return { id, assetId: a.id };
}

function seed() {
  const admin = insertUser(db, {
    username: "admin",
    displayName: "A",
    passwordHash: "x",
    globalRole: "admin",
  }).id;
  const project = createProjectRow(db, { name: "P", createdBy: admin }, now).id;
  const song = createSongRow(db, { projectId: project, title: "S", createdBy: admin }, now).id;
  const shared = blob(100);
  const songOnly = blob(50);
  const projectDoc = doc(project, null, "Setlist", admin, [shared]);
  const lyrics = doc(project, song, "Lyrics", admin, [shared, songOnly]);
  const trashed = doc(project, song, "Old chords", admin, [], true);
  return { admin, project, song, shared, songOnly, projectDoc, lyrics, trashed };
}

describe("dropSongDocuments (SPEC §28.4)", () => {
  it("deletes song documents, releases their files and drops the column", () => {
    const s = seed();
    expect(getUsage(db, s.admin)).toBe(250);
    expect(getBlob(db, s.shared)?.refCount).toBe(2);

    const r = migrateDatabase(db, TEST_MIGRATIONS_DIR, now + 1000, 5000);
    expect(r.droppedSongDocuments).toBe(2);
    expect(r.songDocumentBytesFreed).toBe(150);

    // Song documents and their versions are gone; the project document stays.
    expect(all<{ id: string }>("SELECT id FROM documents").map((d) => d.id)).toEqual([
      s.projectDoc.id,
    ]);
    expect(all("SELECT id FROM document_versions WHERE document_id = ?", s.lyrics.id)).toEqual([]);
    expect(all("SELECT id FROM assets WHERE id = ?", s.lyrics.assetId)).toEqual([]);

    // The shared blob survives; the song-only blob is unreferenced and scheduled for the GC.
    expect(getBlob(db, s.shared)?.refCount).toBe(1);
    expect(getBlob(db, s.songOnly)?.refCount).toBe(0);
    expect(getUsage(db, s.admin)).toBe(100);
    const gc = all<{ payload: string; run_after: number }>(
      "SELECT payload, run_after FROM jobs WHERE type = 'blob.gc'",
    );
    expect(gc).toHaveLength(1);
    expect(JSON.parse(gc[0]?.payload ?? "{}")).toMatchObject({ graceMs: 5000 });
    expect((JSON.parse(gc[0]?.payload ?? "{}") as { hashes: string[] }).hashes).toContain(
      s.songOnly,
    );
    expect(gc[0]?.run_after).toBe(now + 1000 + 5000);
    expect(getSetting(db, "migration.releaseAssets")).toEqual([]);

    // One `document.purged` per document, by the system actor.
    const purged = listEvents(db, { action: "document.purged" });
    expect(purged).toHaveLength(2);
    expect(purged[0]).toMatchObject({ actorType: "system", projectId: s.project, songId: s.song });
    expect(JSON.parse(purged[0]?.details ?? "{}")).toMatchObject({
      reason: "song documents removed",
    });

    // The migration dropped the column; a second run changes nothing.
    expect(hasColumn(db.$client, "documents", "song_id")).toBe(false);
    const events = all("SELECT id FROM events").length;
    expect(migrateDatabase(db, TEST_MIGRATIONS_DIR, now + 2000)).toMatchObject({
      droppedSongDocuments: null,
      songDocumentBytesFreed: 0,
    });
    expect(all("SELECT id FROM events")).toHaveLength(events);
  });

  it("is a no-op without song documents and idempotent before the migrations", () => {
    seed();
    expect(dropSongDocuments(db, now)).toBe(2);
    expect(dropSongDocuments(db, now)).toBe(0);
    expect(getSetting(db, "migration.releaseAssets")).toHaveLength(2);
  });
});
