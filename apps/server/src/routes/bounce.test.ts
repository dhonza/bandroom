import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { matrix } from "@bandroom/fixtures";
import {
  DEFAULT_TOOLS,
  ffmpegArgs,
  getBlob,
  getTrackVersionRow,
  getVariant,
  listEvents,
  LocalStorage,
  runTool,
  setProjectGrantRow,
  updateTrackVersion as updateTrackVersionRow,
  updateUser,
} from "@bandroom/server-core";
import {
  bounceSong,
  createSong,
  getSong,
  listProjectSongs,
  listSongTracks,
  lockSong,
  retryTrackVersion,
  type MixerTrackState,
  type Track,
} from "@bandroom/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { call, runQueuedJobs, tusUpload } from "../testing/testApp";
import {
  admin,
  member,
  memberId,
  projectId,
  setupUploadFixtures,
  songId,
  t,
  tracksOf,
} from "../testing/uploadFixtures";

setupUploadFixtures();

const fixture = (name: string) => {
  const f = matrix().find((x) => x.name === name);
  if (!f) throw new Error(`fixture ${name}`);
  return f.file;
};

const s = (over: Partial<MixerTrackState> = {}): MixerTrackState => ({
  gainDb: 0,
  pan: 0,
  mute: false,
  solo: false,
  listenedVersionId: null,
  ...over,
});

/** Interleaved stereo float samples of a stored variant, decoded at 48 kHz. */
async function decodeVariant(assetId: string, variant: string): Promise<Float32Array> {
  const v = getVariant(t.db, assetId, variant);
  const blob = v && getBlob(t.db, v.blobHash);
  if (!blob) throw new Error(`no ${variant}`);
  const file = await new LocalStorage(path.join(t.dataDir, "blobs")).localPath(blob.storageKey);
  const chunks: Buffer[] = [];
  await runTool(
    DEFAULT_TOOLS.ffmpeg,
    ffmpegArgs("-i", file, "-ac", "2", "-ar", "48000", "-f", "f32le", "-"),
    {
      stdout: async (out: Readable) => {
        for await (const c of out) chunks.push(c as Buffer);
      },
    },
  );
  const buf = Buffer.concat(chunks);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/** Largest |sample| of one channel within ±window frames of `frame`, and where it is. */
function peak(pcm: Float32Array, frame: number, ch: 0 | 1, window = 200) {
  let best = 0;
  let at = -1;
  for (let i = Math.max(0, frame - window); i < frame + window; i++) {
    const a = Math.abs(pcm[2 * i + ch] ?? 0);
    if (a > best) {
      best = a;
      at = i;
    }
  }
  return { value: best, at };
}

const songTracks = async (id: string) =>
  (await call(t, listSongTracks, { params: { id } }, admin)).json<{ tracks: Track[] }>().tracks;
const assetOf = (versionId: string | undefined) =>
  getTrackVersionRow(t.db, versionId ?? "")?.assetId ?? "";

let tracks: Track[];
const byName = (name: string) => {
  const tr = tracks.find((x) => x.name === name);
  if (!tr?.current) throw new Error(`track ${name}`);
  return { trackId: tr.id, versionId: tr.current.id };
};
const versionsOf = (...names: string[]) =>
  Object.fromEntries(names.map((n) => [byName(n).trackId, byName(n).versionId]));

beforeAll(async () => {
  // Mono impulses (0.5, 3, 5.5 s), a stereo file (R = L / 2) and a dual-mono file, all 48 kHz.
  for (const [name, file] of [
    ["Mono", "imp_48000_s24_mono"],
    ["Stereo", "imp_48000_s16_stereo"],
    ["Dual", "imp_48000_s16_dualmono"],
  ] as const) {
    const up = await tusUpload(t, admin, await fs.readFile(fixture(file)), `${name}.wav`, {
      type: "newTrack",
      songId,
      name,
    });
    expect(up.status).toBe(200);
  }
  await runQueuedJobs(t);
  tracks = await tracksOf(admin);
  // Stereo starts at 1 s, Dual at 0.25 s with a −6 dB version gain.
  updateTrackVersionRow(t.db, byName("Stereo").versionId, { offsetSamples: 48_000 });
  updateTrackVersionRow(t.db, byName("Dual").versionId, { offsetSamples: 12_000, gainDb: -6 });
  // The member bounces: editor on the project.
  setProjectGrantRow(t.db, projectId, memberId, "editor", memberId);
}, 120_000);

const bounce = (body: unknown, cookie = member, id = songId) =>
  call(t, bounceSong, { params: { id }, body }, cookie);

describe("POST /songs/:id/bounce (SPEC §5.5)", () => {
  let newSongId = "";

  it(
    "renders the mix with its mutes, gains, pans and offsets into a ready one-track song",
    { timeout: 180_000 },
    async () => {
      const res = await bounce({
        title: "Song (bounce)",
        mix: {
          tracks: {
            [byName("Mono").trackId]: s({ gainDb: -6, pan: -1 }),
            [byName("Stereo").trackId]: s({ mute: true }),
            [byName("Dual").trackId]: s({ pan: 0.5 }),
          },
        },
        versions: versionsOf("Mono", "Stereo", "Dual"),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ song: { id: string; title: string }; versionId: string }>();
      newSongId = body.song.id;
      expect(body.song.title).toBe("Song (bounce)");

      // Created at once: one track named after the song, queued, right after the source.
      const created = await songTracks(newSongId);
      expect(created).toHaveLength(1);
      expect(created[0]?.name).toBe("Song (bounce)");
      expect(created[0]?.current?.status).toBe("queued");
      const order = (await call(t, listProjectSongs, { params: { id: projectId } }, admin)).json<{
        songs: { id: string }[];
      }>().songs;
      expect(order.map((x) => x.id).slice(0, 2)).toEqual([songId, newSongId]);
      const bounced = listEvents(t.db, { action: "song.bounced", targetId: newSongId });
      expect(bounced).toHaveLength(1);
      expect(JSON.parse(bounced[0]?.details ?? "{}")).toMatchObject({
        sourceSongId: songId,
        versions: versionsOf("Mono", "Stereo", "Dual"),
      });

      expect(await runQueuedJobs(t)).toEqual(["done", "done"]); // bounce, then ingest
      const [track] = await songTracks(newSongId);
      const v = track?.current;
      expect(v?.status).toBe("ready");
      expect(v?.source).toBe("render");
      expect(v?.uploadedBy).toBe(memberId);
      expect(listEvents(t.db, { action: "version.rendered", targetId: v?.id })).toHaveLength(1);

      // Stored like an upload: verified FLAC (the 24-bit original is dropped), Opus, peaks.
      const assetId = assetOf(v?.id);
      for (const variant of ["flac", "opus", "opus_low", "peaks"])
        expect(getVariant(t.db, assetId, variant), variant).toBeDefined();
      const pcm = await decodeVariant(assetId, "flac");
      expect(pcm.length / 2).toBe(Math.round(6.25 * 48_000)); // Dual ends at 0.25 + 6 s
      const amp = 0.9;
      // Mono at −6 dB, hard left: equal-power law gives L = 1, R = 0.
      const monoL = peak(pcm, 24_000, 0);
      expect(monoL.at).toBe(24_000);
      expect(monoL.value).toBeCloseTo(amp * 10 ** (-6 / 20), 3);
      expect(peak(pcm, 24_000, 1, 2).value).toBeLessThan(1e-4);
      // Dual-mono at 0.25 s, −6 dB version gain, pan 0.5 with the balance law.
      const theta = (1.5 * Math.PI) / 4;
      const dualL = peak(pcm, 36_000, 0);
      const dualR = peak(pcm, 36_000, 1);
      expect(dualL.at).toBe(36_000);
      expect(dualR.at).toBe(36_000);
      expect(dualL.value).toBeCloseTo(amp * 10 ** (-6 / 20) * Math.SQRT2 * Math.cos(theta), 3);
      expect(dualR.value).toBeCloseTo(amp * 10 ** (-6 / 20), 3);
      // The muted stereo track (impulse at 1 + 0.5 s) is not in the bounce.
      expect(peak(pcm, 72_000, 0).value).toBeLessThan(1e-4);
    },
  );

  it("keeps only soloed tracks, at their offsets", { timeout: 180_000 }, async () => {
    const res = await bounce({
      title: "Solo",
      mix: {
        tracks: {
          [byName("Mono").trackId]: s(),
          [byName("Stereo").trackId]: s({ solo: true }),
        },
      },
      // Dual has no mix entry: its default mix applies, and the solo silences it.
      versions: versionsOf("Mono", "Stereo", "Dual"),
    });
    expect(res.statusCode).toBe(200);
    expect(await runQueuedJobs(t)).toEqual(["done", "done"]);
    const id = res.json<{ song: { id: string } }>().song.id;
    const [track] = await songTracks(id);
    const pcm = await decodeVariant(assetOf(track?.current?.id), "flac");
    expect(pcm.length / 2).toBe(7 * 48_000);
    // 0.9 is above −1 dBTP: the limiter runs, without moving the impulse.
    const l = peak(pcm, 72_000, 0);
    const r = peak(pcm, 72_000, 1);
    expect(l.at).toBe(72_000);
    expect(r.at).toBe(72_000);
    expect(l.value).toBeGreaterThan(0.8);
    expect(l.value).toBeLessThanOrEqual(0.9);
    expect(r.value / l.value).toBeCloseTo(0.5, 2);
    expect(peak(pcm, 24_000, 0).value).toBeLessThan(1e-4); // Mono silenced
    expect(peak(pcm, 36_000, 0).value).toBeLessThan(1e-4); // Dual silenced
  });

  it("refuses versions that are not the song's, and a silent mix", async () => {
    const other = (
      await call(t, createSong, { params: { id: projectId }, body: { title: "Other" } }, admin)
    ).json<{ song: { id: string } }>().song.id;
    const up = await tusUpload(
      t,
      admin,
      await fs.readFile(fixture("imp_48000_s16_mono")),
      "x.wav",
      {
        type: "newTrack",
        songId: other,
        name: "Foreign",
      },
    );
    expect(up.status).toBe(200);
    const foreign = JSON.parse(up.body) as { trackId: string; trackVersionId: string };
    const mix = { tracks: {} };
    // A version of another song's track, or under the wrong track.
    for (const versions of [
      { [foreign.trackId]: foreign.trackVersionId },
      { [byName("Mono").trackId]: foreign.trackVersionId },
      { [byName("Mono").trackId]: byName("Stereo").versionId },
      { missing: byName("Mono").versionId },
    ]) {
      const res = await bounce({ title: "X", mix, versions });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ code: string }>().code).toBe("BOUNCE_INVALID");
    }
    // Not ready yet (queued ingest) in its own song.
    const queued = await bounce(
      { title: "X", mix, versions: { [foreign.trackId]: foreign.trackVersionId } },
      admin,
      other,
    );
    expect(queued.json<{ code: string }>().code).toBe("BOUNCE_INVALID");
    await runQueuedJobs(t);

    const silent = await bounce({
      title: "X",
      mix: { tracks: { [byName("Mono").trackId]: s({ mute: true }) } },
      versions: versionsOf("Mono"),
    });
    expect(silent.statusCode).toBe(400);
    expect(silent.json<{ code: string }>().code).toBe("BOUNCE_SILENT");
  });

  it("refuses a bounce over the user's quota and creates nothing", async () => {
    const before = listEvents(t.db, { action: "song.bounced" }).length;
    updateUser(t.db, memberId, { quotaBytes: 1000 });
    try {
      const res = await bounce({ title: "Big", mix: { tracks: {} }, versions: versionsOf("Mono") });
      expect(res.statusCode).toBe(413);
      expect(res.json<{ code: string }>().code).toBe("QUOTA_EXCEEDED");
    } finally {
      updateUser(t.db, memberId, { quotaBytes: null });
    }
    expect(listEvents(t.db, { action: "song.bounced" })).toHaveLength(before);
  });

  it(
    "fails with QUOTA_EXCEEDED when the render does not fit, and a retry renders it again",
    { timeout: 180_000 },
    async () => {
      const res = await bounce({
        title: "Later",
        mix: { tracks: {} },
        versions: versionsOf("Mono"),
      });
      expect(res.statusCode).toBe(200);
      const id = res.json<{ song: { id: string } }>().song.id;
      updateUser(t.db, memberId, { quotaBytes: 1 });
      try {
        expect(await runQueuedJobs(t)).toEqual(["failed"]);
      } finally {
        updateUser(t.db, memberId, { quotaBytes: null });
      }
      const failed = (await songTracks(id))[0]?.current;
      expect(failed?.status).toBe("failed");
      expect(failed?.error).toMatch(/^QUOTA_EXCEEDED/);
      const retry = await call(t, retryTrackVersion, { params: { id: failed?.id ?? "" } }, member);
      expect(retry.statusCode).toBe(200);
      expect(await runQueuedJobs(t)).toEqual(["done", "done"]);
      expect((await songTracks(id))[0]?.current?.status).toBe("ready");
    },
  );

  it("bounces a locked song (it only reads it)", async () => {
    expect((await call(t, lockSong, { params: { id: songId } }, admin)).statusCode).toBe(200);
    const res = await bounce({
      title: "Locked",
      mix: { tracks: {} },
      versions: versionsOf("Mono"),
    });
    expect(res.statusCode).toBe(200);
    await runQueuedJobs(t);
  });

  it("tells the client whether the user may bounce", async () => {
    const flag = async (cookie: string) =>
      (await call(t, getSong, { params: { id: songId } }, cookie)).json<{
        song: { canBounce?: boolean };
      }>().song.canBounce;
    expect(await flag(admin)).toBe(true);
    expect(await flag(member)).toBe(true);
    setProjectGrantRow(t.db, projectId, memberId, "contributor", memberId);
    expect(await flag(member)).toBe(false);
    const res = await bounce({ title: "No", mix: { tracks: {} }, versions: versionsOf("Mono") });
    expect(res.statusCode).toBe(403);
    setProjectGrantRow(t.db, projectId, memberId, "editor", memberId);
  });
});
