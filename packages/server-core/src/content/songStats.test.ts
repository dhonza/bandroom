import { uuidv7 } from "@bandroom/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertUser } from "../auth/users";
import type { Db } from "../db/connection";
import { blobs } from "../db/schema";
import { createAsset, setAssetProbe, setAssetStatus } from "../media/assets";
import { putVariant } from "../media/variants";
import { createTestDb } from "../testing/testDb";
import { createProjectRow } from "./projects";
import { createSongRow } from "./songs";
import { songStatsBySong } from "./songStats";
import { addTrackVersion, createTrackWithVersion } from "./tracks";

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

const run = (sql: string, ...p: unknown[]) => db.$client.prepare(sql).run(...p);

/** An audio asset with an Opus of `seconds` and `channels`; `ready` unless told otherwise. */
function audio(
  seconds: number,
  channels: 1 | 2,
  opts: { ready?: boolean; variant?: string; dualMono?: boolean } = {},
): string {
  const a = createAsset(db, {
    kind: "audio",
    originalFilename: "f",
    sizeBytes: 1,
    originalHash: uuidv7(),
    uploadedBy: user,
  });
  const hash = uuidv7().replaceAll("-", "");
  db.insert(blobs).values({ hash, sizeBytes: 10, storageKey: hash, createdAt: 1 }).run();
  putVariant(db, a.id, opts.variant ?? "opus", hash, {
    codec: "opus",
    channels,
    durationSamples48k: seconds * 48_000,
  });
  if (opts.dualMono) {
    setAssetProbe(db, a.id, {
      durationSec: seconds,
      durationSamples: seconds * 48_000,
      sampleRate: 48_000,
      channels: 2,
      bitDepth: 16,
      codec: "pcm_s16le",
      lossless: true,
      dualMono: true,
    } as Parameters<typeof setAssetProbe>[2]);
  }
  if (opts.ready !== false) setAssetStatus(db, a.id, "ready");
  return a.id;
}

describe("songStatsBySong (SPEC §11.2)", () => {
  it("gives the longest end incl. offsets and the mono/stereo counts of current ready versions", () => {
    const project = createProjectRow(db, { name: "P", createdBy: user }).id;
    const song = createSongRow(db, { projectId: project, title: "S", createdBy: user }).id;
    const track = (name: string, assetId: string) =>
      createTrackWithVersion(db, { songId: song, name, assetId, uploadedBy: user });
    // Drums 60 s stereo; Bass 50 s mono starting at 20 s → ends at 70 s.
    track("Drums", audio(60, 2));
    const bass = track("Bass", audio(50, 1));
    run("UPDATE track_versions SET offset_samples = ? WHERE id = ?", 20 * 48_000, bass.version.id);
    // A dual-mono source plays one channel: mono.
    track("Vox", audio(30, 1, { dualMono: true }));
    // Only an opus_low (no opus): still counted.
    track("Keys", audio(10, 2, { variant: "opus_low" }));
    // Current version still processing: left out, even though an older one is ready.
    const gtr = track("Gtr", audio(100, 2));
    addTrackVersion(db, {
      trackId: gtr.track.id,
      assetId: audio(200, 2, { ready: false }),
      uploadedBy: user,
    });
    // A deleted track: left out.
    const gone = track("Gone", audio(500, 2));
    run("UPDATE tracks SET deleted_at = 1 WHERE id = ?", gone.track.id);

    expect(songStatsBySong(db, project).get(song)).toEqual({
      durationSec: 70,
      channels: { stereo: 2, mono: 2 },
    });
  });

  it("leaves out songs without ready audio and deleted songs", () => {
    const project = createProjectRow(db, { name: "P", createdBy: user }).id;
    const empty = createSongRow(db, { projectId: project, title: "E", createdBy: user }).id;
    const pending = createSongRow(db, { projectId: project, title: "W", createdBy: user }).id;
    createTrackWithVersion(db, {
      songId: pending,
      name: "T",
      assetId: audio(10, 2, { ready: false }),
      uploadedBy: user,
    });
    const trashed = createSongRow(db, { projectId: project, title: "D", createdBy: user }).id;
    createTrackWithVersion(db, {
      songId: trashed,
      name: "T",
      assetId: audio(10, 2),
      uploadedBy: user,
    });
    run("UPDATE songs SET deleted_at = 1 WHERE id = ?", trashed);
    const stats = songStatsBySong(db, project);
    expect(stats.has(empty)).toBe(false);
    expect(stats.has(pending)).toBe(false);
    expect(stats.has(trashed)).toBe(false);
  });
});
