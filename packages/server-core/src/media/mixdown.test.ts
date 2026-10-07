import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { generateFixtures, matrix, TONE_FILE } from "@bandroom/fixtures";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertUser } from "../auth/users";
import { createProjectRow } from "../content/projects";
import { createSongRow } from "../content/songs";
import {
  addTrackVersion,
  createTrackWithVersion,
  listenSource,
  systemMixTrack,
  updateTrack,
  updateTrackVersion,
} from "../content/tracks";
import type { Db } from "../db/connection";
import { assets, jobs } from "../db/schema";
import {
  addOriginal,
  createHarness,
  decodeMono,
  runOneJob,
  variantPath,
  type Harness,
} from "../testing/ingestHarness";
import { makeTempDir } from "../testing/tempDir";
import { createTestDb } from "../testing/testDb";
import { claimJob, enqueueJob } from "../jobs/queue";
import { assetProbe, createAsset, getAsset } from "./assets";
import {
  MIXDOWN_DELAY_MS,
  MIXDOWN_IMPORT_DELAY_MS,
  scheduleMixdown,
  scheduleMixdownAfterIngest,
} from "./mixdown";
import { DEFAULT_TOOLS, ffmpegArgs, runTool } from "./tools";
import { getUsage, listVariants, SYSTEM_USAGE_ID } from "./variants";

let t: ReturnType<typeof createTestDb>;
let db: Db;
let tmp: ReturnType<typeof makeTempDir>;
let h: Harness;
let userId: string;

beforeAll(async () => {
  await generateFixtures();
  t = createTestDb();
  db = t.db;
  tmp = makeTempDir();
  h = createHarness(db, tmp.dir);
  userId = insertUser(db, {
    username: "u",
    displayName: "U",
    passwordHash: "x",
    globalRole: "member",
  }).id;
}, 60_000);
afterAll(() => {
  t.close();
  tmp.cleanup();
});

function newSong(): string {
  const p = createProjectRow(db, { name: "P", createdBy: userId });
  return createSongRow(db, { projectId: p.id, title: "S", createdBy: userId }).id;
}

async function addTrack(
  songId: string,
  file: string,
  name: string,
  role: "track" | "mix" = "track",
) {
  const asset = await addOriginal(h, file, userId);
  const { track, version } = createTrackWithVersion(db, {
    songId,
    name,
    role,
    assetId: asset.id,
    uploadedBy: userId,
  });
  const { status } = await runOneJob(h, "audio.ingest", { assetId: asset.id, role, songId });
  expect(status).toBe("done");
  return { track, version };
}

const mix = (songId: string) => runOneJob(h, "audio.mixdown", { songId });

/** Interleaved stereo float samples of a file. */
async function decodeStereo(file: string): Promise<Float32Array> {
  const chunks: Buffer[] = [];
  await runTool(DEFAULT_TOOLS.ffmpeg, ffmpegArgs("-i", file, "-ac", "2", "-f", "f32le", "-"), {
    stdout: async (s: Readable) => {
      for await (const c of s) chunks.push(c as Buffer);
    },
  });
  const buf = Buffer.concat(chunks);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

describe("scheduleMixdown", () => {
  it("keeps one queued job per song and postpones it on each change", () => {
    const songId = newSong();
    scheduleMixdown(db, songId, 1000);
    scheduleMixdown(db, songId, 5000);
    const rows = db
      .select()
      .from(jobs)
      .where(and(eq(jobs.type, "audio.mixdown"), eq(jobs.dedupeKey, `mixdown:${songId}`)))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.runAfter).toBe(5000 + MIXDOWN_DELAY_MS);
  });

  // Runs a real ingest (ffmpeg), so it needs more than the default 5 s on a loaded machine.
  it("is scheduled when an ingest of a song track completes", { timeout: 60_000 }, async () => {
    const songId = newSong();
    await addTrack(songId, TONE_FILE(), "Tone");
    const queued = db
      .select()
      .from(jobs)
      .where(eq(jobs.dedupeKey, `mixdown:${songId}`))
      .all();
    expect(queued.map((j) => j.status)).toEqual(["queued"]);
  });
});

describe("default mix during imports (SPEC §25.5)", () => {
  const mixdownRunAfter = (songId: string) =>
    db
      .select()
      .from(jobs)
      .where(and(eq(jobs.dedupeKey, `mixdown:${songId}`), eq(jobs.status, "queued")))
      .get()?.runAfter;
  const fakeVersion = (songId: string, source: "upload" | "import") => {
    const asset = createAsset(db, {
      kind: "audio",
      originalFilename: "x.wav",
      sizeBytes: 1,
      originalHash: "0".repeat(64),
      uploadedBy: userId,
    });
    return createTrackWithVersion(db, {
      songId,
      name: "T",
      role: "track",
      assetId: asset.id,
      uploadedBy: userId,
      source,
    });
  };

  it("uses the short debounce after an imported version, 60 s after an upload", () => {
    const imported = newSong();
    const { version: iv } = fakeVersion(imported, "import");
    scheduleMixdownAfterIngest(db, imported, iv.id, 1000);
    expect(mixdownRunAfter(imported)).toBe(1000 + MIXDOWN_IMPORT_DELAY_MS);
    const uploaded = newSong();
    const { version: uv } = fakeVersion(uploaded, "upload");
    scheduleMixdownAfterIngest(db, uploaded, uv.id, 1000);
    expect(mixdownRunAfter(uploaded)).toBe(1000 + MIXDOWN_DELAY_MS);
    // Without a version (older jobs): the usual debounce.
    const bare = newSong();
    scheduleMixdownAfterIngest(db, bare, null, 1000);
    expect(mixdownRunAfter(bare)).toBe(1000 + MIXDOWN_DELAY_MS);
  });

  it("is not scheduled by an older version of a stack (the mix does not change)", () => {
    const songId = newSong();
    const { track, version: v1 } = fakeVersion(songId, "import");
    const asset = createAsset(db, {
      kind: "audio",
      originalFilename: "y.wav",
      sizeBytes: 1,
      originalHash: "1".repeat(64),
      uploadedBy: userId,
    });
    const v2 = addTrackVersion(db, {
      trackId: track.id,
      assetId: asset.id,
      uploadedBy: userId,
      source: "import",
    });
    scheduleMixdownAfterIngest(db, songId, v1.id, 1000);
    expect(mixdownRunAfter(songId)).toBeUndefined();
    scheduleMixdownAfterIngest(db, songId, v2.id, 1000);
    expect(mixdownRunAfter(songId)).toBe(1000 + MIXDOWN_IMPORT_DELAY_MS);
  });

  it("runs a due mixdown before the remaining import ingests of other songs", () => {
    db.delete(jobs).run();
    const first = newSong();
    const caps = ["audio.ingest", "audio.mixdown"];
    // The importer queued every song's ingests at its low priority (−5) up front.
    for (let i = 0; i < 3; i++) {
      enqueueJob(
        db,
        { type: "audio.ingest", capability: "audio.ingest", payload: { i }, priority: -5 },
        100 + i,
      );
    }
    // The first song's last track is ingested at t = 1000: its mix is due 10 s later.
    const { version } = fakeVersion(first, "import");
    scheduleMixdownAfterIngest(db, first, version.id, 1000);
    // Before the debounce, the worker keeps ingesting.
    expect(claimJob(db, "w", caps, 5000)?.type).toBe("audio.ingest");
    // Once due, the mix goes first although older ingests wait.
    const next = claimJob(db, "w", caps, 1000 + MIXDOWN_IMPORT_DELAY_MS);
    expect(next?.type).toBe("audio.mixdown");
    expect(JSON.parse(next?.payload ?? "{}")).toMatchObject({ songId: first });
    // An interactive upload (priority 0) still goes before a due mixdown.
    const second = newSong();
    scheduleMixdown(db, second, 0, 0);
    enqueueJob(db, { type: "audio.ingest", capability: "audio.ingest", payload: {}, priority: 0 });
    expect(claimJob(db, "w", caps, Date.now())?.priority).toBe(0);
    expect(claimJob(db, "w", caps, Date.now())?.type).toBe("audio.mixdown");
  });
});

describe("audio.mixdown (SPEC §5.5)", () => {
  it(
    "renders current versions with offsets onto a hidden system track",
    { timeout: 120_000 },
    async () => {
      const songId = newSong();
      const imp = matrix().find((x) => x.name === "imp_48000_s16_mono");
      if (!imp) throw new Error("fixture");
      await addTrack(songId, TONE_FILE(), "Tone"); // 10 s stereo
      const { version } = await addTrack(songId, imp.file, "Click"); // 6 s mono
      updateTrackVersion(db, version.id, { offsetSamples: 48_000 * 11 }); // starts at 11 s → ends at 17 s

      const { status, job } = await mix(songId);
      expect(status).toBe("done");
      expect(
        JSON.parse(db.select().from(jobs).where(eq(jobs.id, job.id)).get()?.result ?? "{}"),
      ).toMatchObject({ status: "rendered", inputs: 2 });

      const src = listenSource(db, songId);
      expect(src?.isAutoMix).toBe(true);
      expect(src?.details.asset.uploadedBy).toBeNull();
      expect(
        listVariants(db, src?.details.asset.id ?? "")
          .map((v) => v.variant)
          .sort(),
      ).toEqual(["opus", "opus_low", "peaks", "seekindex_opus", "seekindex_opus_low"]);
      const probe = assetProbe(getAsset(db, src?.details.asset.id ?? "") ?? (undefined as never));
      expect(probe?.durationSamples).toBe(17 * 48_000);
      expect(getUsage(db, SYSTEM_USAGE_ID)).toBeGreaterThan(0);

      // The click (impulse at 0.5 s of its file) lands at 11.5 s in the mix, after the tone ends.
      const pcm = await decodeMono(await variantPath(h, src?.details.asset.id ?? "", "opus"));
      let best = 0;
      let at = 0;
      for (let i = 11 * 48_000; i < 12 * 48_000; i++) {
        const a = Math.abs(pcm[i] ?? 0);
        if (a > best) {
          best = a;
          at = i;
        }
      }
      expect(Math.abs(at - 11.5 * 48_000)).toBeLessThan(48); // within 1 ms after Opus smearing

      // A second render replaces the first auto-mix version.
      await mix(songId);
      const sys = systemMixTrack(db, songId);
      const again = listenSource(db, songId);
      expect(again?.details.version.id).not.toBe(src?.details.version.id);
      expect(again?.details.version.number).toBe(2);
      expect(sys?.isSystem).toBe(true);
      expect(listVariants(db, src?.details.asset.id ?? "")).toEqual([]); // old variants released
    },
  );

  it(
    "leaves out muted tracks and removes the auto-mix when nothing is audible",
    { timeout: 120_000 },
    async () => {
      const songId = newSong();
      const { track } = await addTrack(songId, TONE_FILE(), "Tone");
      await mix(songId);
      expect(listenSource(db, songId)).not.toBeNull();
      updateTrack(db, track.id, { defaultMuted: true });
      await mix(songId);
      expect(listenSource(db, songId)).toBeNull();
      expect(systemMixTrack(db, songId)).toBeUndefined();
    },
  );

  it(
    "applies the current version's gain on top of the default gain",
    { timeout: 120_000 },
    async () => {
      const songId = newSong();
      const { version } = await addTrack(songId, TONE_FILE(), "Tone");
      const lufs = async () => {
        await mix(songId);
        const asset = getAsset(db, listenSource(db, songId)?.details.asset.id ?? "");
        return assetProbe(asset ?? (undefined as never))?.loudness?.integratedLufs ?? Number.NaN;
      };
      const unity = await lufs();
      updateTrackVersion(db, version.id, { gainDb: -12 });
      expect((await lufs()) - unity).toBeCloseTo(-12, 0);
    },
  );

  it(
    "plays a dual-mono source in both channels at unity, true mono at −3 dB per side",
    { timeout: 120_000 },
    async () => {
      // Energy per side over the file; −12 dB keeps the impulses away from the limiter.
      const energy = async (layout: "dualmono" | "mono") => {
        const fx = matrix().find((x) => x.name === `imp_48000_s16_${layout}`);
        if (!fx) throw new Error("fixture");
        const songId = newSong();
        const { track } = await addTrack(songId, fx.file, layout);
        updateTrack(db, track.id, { defaultGainDb: -12 });
        await mix(songId);
        const out = await variantPath(h, listenSource(db, songId)?.details.asset.id ?? "", "opus");
        const pcm = await decodeStereo(out);
        let l = 0;
        let r = 0;
        for (let i = 0; i + 1 < pcm.length; i += 2) {
          l += (pcm[i] ?? 0) ** 2;
          r += (pcm[i + 1] ?? 0) ** 2;
        }
        return { l, r };
      };
      const dual = await energy("dualmono");
      expect(dual.r).toBeGreaterThan(0); // was silent before the fix
      expect(dual.l / dual.r).toBeCloseTo(1, 1);
      const mono = await energy("mono");
      expect(mono.l / mono.r).toBeCloseTo(1, 1);
      // Dual-mono plays like its stereo original (unity); true mono is 3 dB lower per side.
      expect(10 * Math.log10(mono.l / dual.l)).toBeCloseTo(-3, 0);
    },
  );

  it("limits a clipping sum", { timeout: 120_000 }, async () => {
    const songId = newSong();
    // Two full tone tracks at +6 dB clearly exceed −1 dBTP.
    const a = await addTrack(songId, TONE_FILE(), "A");
    const b = await addTrack(songId, TONE_FILE(), "B");
    updateTrack(db, a.track.id, { defaultGainDb: 6 });
    updateTrack(db, b.track.id, { defaultGainDb: 6 });
    const { job } = await mix(songId);
    expect(
      JSON.parse(db.select().from(jobs).where(eq(jobs.id, job.id)).get()?.result ?? "{}"),
    ).toMatchObject({ limited: true });
    const probe = assetProbe(
      getAsset(db, listenSource(db, songId)?.details.asset.id ?? "") ?? (undefined as never),
    );
    expect(probe?.loudness?.truePeakDbtp ?? 0).toBeLessThanOrEqual(-0.9);
  });

  it("leaves no orphan asset when encoding the render fails (review M10)", async () => {
    const songId = newSong();
    await addTrack(songId, TONE_FILE(), "Tone");
    // An ffmpeg that renders the mix but fails every Opus encode.
    const fake = path.join(tmp.dir, "ffmpeg-no-opus.sh");
    await fs.writeFile(
      fake,
      `#!/bin/sh\ncase "$*" in *libopus*) exit 1;; esac\nexec ${DEFAULT_TOOLS.ffmpeg} "$@"\n`,
      { mode: 0o755 },
    );
    const renders = () =>
      db.select().from(assets).where(eq(assets.originalFilename, "auto-mix.wav")).all().length;
    const before = { renders: renders(), usage: getUsage(db, SYSTEM_USAGE_ID) };
    const { status } = await runOneJob(
      h,
      "audio.mixdown",
      { songId },
      { ...DEFAULT_TOOLS, ffmpeg: fake },
    );
    expect(status).toBe("queued"); // retried later
    expect(renders()).toBe(before.renders);
    expect(getUsage(db, SYSTEM_USAGE_ID)).toBe(before.usage);
    expect(listenSource(db, songId)).toBeNull();
  }, 120_000);

  it("is removed once the band uploads its own mix track", { timeout: 120_000 }, async () => {
    const songId = newSong();
    await addTrack(songId, TONE_FILE(), "Tone");
    await mix(songId);
    expect(listenSource(db, songId)?.isAutoMix).toBe(true);
    await addTrack(songId, TONE_FILE(), "Master", "mix");
    expect(listenSource(db, songId)?.isAutoMix).toBe(false);
    await mix(songId);
    expect(systemMixTrack(db, songId)).toBeUndefined();
  });
});
