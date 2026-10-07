import { uuidv7 } from "@bandroom/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertUser } from "../auth/users";
import type { Db } from "../db/connection";
import { blobs } from "../db/schema";
import { createAsset } from "../media/assets";
import { putVariant } from "../media/variants";
import { createTestDb } from "../testing/testDb";
import { createDocumentWithVersion } from "./documents";
import { createProjectRow } from "./projects";
import { createSongRow } from "./songs";
import { bytesByProject, bytesBySong, bytesByTrack, songBytes } from "./storageBytes";
import { addTrackVersion, createTrackWithVersion, versionDetails } from "./tracks";

let db: Db;
let close: () => void;
let user = "";

beforeEach(() => {
  ({ db, close } = createTestDb());
  user = insertUser(db, {
    username: "u",
    displayName: "U",
    passwordHash: "x",
    globalRole: "admin",
  }).id;
});
afterEach(() => {
  close();
});

function blob(size: number): string {
  const hash = uuidv7().replaceAll("-", "");
  db.insert(blobs).values({ hash, sizeBytes: size, storageKey: hash, createdAt: 1 }).run();
  return hash;
}

/** An asset storing the given blobs as variants. */
function asset(kind: "audio" | "document" | "image" | "midi", ...hashes: string[]): string {
  const a = createAsset(db, {
    kind,
    originalFilename: "f",
    sizeBytes: 1,
    originalHash: uuidv7(),
    uploadedBy: user,
  });
  hashes.forEach((h, i) => {
    putVariant(db, a.id, `v${String(i)}`, h);
  });
  return a.id;
}

const run = (sql: string, ...p: unknown[]) => db.$client.prepare(sql).run(...p);

describe("storage sizes (SPEC §28.6)", () => {
  it("sums the stored files per version, track, song and project", () => {
    const project = createProjectRow(db, { name: "P", createdBy: user }).id;
    const empty = createProjectRow(db, { name: "Empty", createdBy: user }).id;
    const song = createSongRow(db, { projectId: project, title: "S", createdBy: user }).id;
    const other = createSongRow(db, { projectId: project, title: "T", createdBy: user }).id;
    const shared = blob(1000);
    const opus = blob(100);
    // Bass: v1 (shared + opus), v2 (shared again + 50): the shared file counts once.
    const bass = createTrackWithVersion(db, {
      songId: song,
      name: "Bass",
      assetId: asset("audio", shared, opus),
      uploadedBy: user,
    });
    const v2 = addTrackVersion(db, {
      trackId: bass.track.id,
      assetId: asset("audio", shared, blob(50)),
      uploadedBy: user,
    });
    // Drums: 200, and a deleted version (300) that is left out.
    const drums = createTrackWithVersion(db, {
      songId: song,
      name: "Drums",
      assetId: asset("audio", blob(200)),
      uploadedBy: user,
    });
    const gone = addTrackVersion(db, {
      trackId: drums.track.id,
      assetId: asset("audio", blob(300)),
      uploadedBy: user,
    });
    run("UPDATE track_versions SET deleted_at = 1 WHERE id = ?", gone.id);
    // A deleted track (400): left out.
    const trashed = createTrackWithVersion(db, {
      songId: song,
      name: "Old",
      assetId: asset("audio", blob(400)),
      uploadedBy: user,
    });
    run("UPDATE tracks SET deleted_at = 1 WHERE id = ?", trashed.track.id);
    // Tempo MIDI (current and an older revision): 10 + 20.
    run(
      `INSERT INTO tempo_maps (song_id, source, data, midi_asset_id, revision_id, updated_at)
       VALUES (?, 'midi', '{}', ?, 'r', 1)`,
      song,
      asset("midi", blob(10)),
    );
    run(
      `INSERT INTO tempo_map_revisions (id, song_id, source, data, midi_asset_id, created_at)
       VALUES ('r0', ?, 'midi', '{}', ?, 1)`,
      song,
      asset("midi", blob(20)),
    );
    // The other song shares the bass file: counted for that song and once in the project.
    createTrackWithVersion(db, {
      songId: other,
      name: "Copy",
      assetId: asset("audio", shared),
      uploadedBy: user,
    });
    // A deleted song (500): left out of the project.
    const deadSong = createSongRow(db, { projectId: project, title: "X", createdBy: user }).id;
    createTrackWithVersion(db, {
      songId: deadSong,
      name: "A",
      assetId: asset("audio", blob(500)),
      uploadedBy: user,
    });
    run("UPDATE songs SET deleted_at = 1 WHERE id = ?", deadSong);
    // A project document (60) and a deleted one (70), and the image (5).
    createDocumentWithVersion(db, {
      projectId: project,
      title: "Setlist",
      kind: "text",
      assetId: asset("document", blob(60)),
      createdBy: user,
    });
    const deadDoc = createDocumentWithVersion(db, {
      projectId: project,
      title: "Old",
      kind: "text",
      assetId: asset("document", blob(70)),
      createdBy: user,
    });
    run("UPDATE documents SET deleted_at = 1 WHERE id = ?", deadDoc.document.id);
    run("UPDATE projects SET image_asset_id = ? WHERE id = ?", asset("image", blob(5)), project);

    const tracks = bytesByTrack(db, song);
    expect(tracks.get(bass.track.id)).toBe(1150);
    expect(tracks.get(drums.track.id)).toBe(200);
    expect(tracks.has(trashed.track.id)).toBe(false);
    const songs = bytesBySong(db, project);
    expect(songs.get(song)).toBe(1150 + 200 + 30);
    expect(songs.get(other)).toBe(1000);
    expect(songs.has(deadSong)).toBe(false);
    expect(songBytes(db, song)).toBe(1380);
    const projects = bytesByProject(db, [project, empty]);
    expect(projects.get(project)).toBe(1380 + 60 + 5);
    expect(projects.get(empty) ?? 0).toBe(0);
    expect(bytesByProject(db, [])).toEqual(new Map());

    // Per version: the sizes of its asset's files.
    const details = versionDetails(db, v2);
    expect(details?.variants.map((v) => v.sizeBytes).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      50, 1000,
    ]);
  });
});
