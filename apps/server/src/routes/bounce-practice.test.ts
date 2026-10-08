import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { matrix } from "@bandroom/fixtures";
import {
  BouncePayloadSchema,
  DEFAULT_TOOLS,
  ffmpegArgs,
  getBlob,
  getTrackVersionRow,
  getVariant,
  listEvents,
  LocalStorage,
  runTool,
  schema,
  setProjectGrantRow,
} from "@bandroom/server-core";
import {
  bounceSong,
  clickFrames,
  compileTempo,
  createMarker,
  getSongTempo,
  listSongMarkers,
  listSongTracks,
  putSongTempo,
  synthClick,
  updateSong,
  type Marker,
  type MixerState,
  type MixerTrackState,
  type SongTempo,
  type Track,
} from "@bandroom/shared";
import { desc, eq } from "drizzle-orm";
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

/**
 * Bounce with practice settings (SPEC §30.7, §30.8): an impulse at 3 s bounced at 75 % lands at
 * 4 s; the copied tempo map and markers are scaled and the click lands on the scaled grid; drum
 * tracks keep their pitch (and at rate 1 are mixed straight from the source); the key is
 * transposed; without `applyPractice` the setting is ignored.
 */

setupUploadFixtures();

const SR = 48_000;
const LENGTH = 6 * SR;

const s = (over: Partial<MixerTrackState> = {}): MixerTrackState => ({
  gainDb: 0,
  pan: 0,
  mute: false,
  solo: false,
  listenedVersionId: null,
  ...over,
});

/** The left channel of a stored variant at 48 kHz. */
async function decodeVariant(assetId: string, variant: string): Promise<Float32Array> {
  const v = getVariant(t.db, assetId, variant);
  const blob = v && getBlob(t.db, v.blobHash);
  if (!blob) throw new Error(`no ${variant}`);
  const file = await new LocalStorage(path.join(t.dataDir, "blobs")).localPath(blob.storageKey);
  const chunks: Buffer[] = [];
  await runTool(
    DEFAULT_TOOLS.ffmpeg,
    ffmpegArgs("-i", file, "-af", "pan=mono|c0=c0", "-ar", "48000", "-f", "f32le", "-"),
    {
      stdout: async (out: Readable) => {
        for await (const c of out) chunks.push(c as Buffer);
      },
    },
  );
  const buf = Buffer.concat(chunks);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

const songTracks = async (id: string) =>
  (await call(t, listSongTracks, { params: { id } }, admin)).json<{ tracks: Track[] }>().tracks;

/** The bounced song's rendered audio (after the bounce and its ingest ran). */
async function renderedPcm(newSongId: string): Promise<Float32Array> {
  expect(await runQueuedJobs(t)).toEqual(["done", "done"]);
  const [track] = await songTracks(newSongId);
  const assetId = getTrackVersionRow(t.db, track?.current?.id ?? "")?.assetId ?? "";
  return decodeVariant(assetId, "flac");
}

function peakAt(x: Float32Array, from: number, to: number): number {
  let best = -1;
  let at = -1;
  for (let i = Math.max(0, from); i < Math.min(x.length, to); i++) {
    const v = Math.abs(x[i] ?? 0);
    if (v > best) {
      best = v;
      at = i;
    }
  }
  return at;
}

/** The payload of the last queued `audio.bounce`. */
function lastBouncePayload() {
  const row = t.db
    .select()
    .from(schema.jobs)
    .where(eq(schema.jobs.type, "audio.bounce"))
    .orderBy(desc(schema.jobs.createdAt))
    .get();
  return BouncePayloadSchema.parse(JSON.parse(row?.payload ?? "{}"));
}

const eventDetails = (action: "song.bounced" | "version.rendered", id: string) =>
  listEvents(t.db, { action })
    .filter((e) => e.songId === id)
    .map((e) => JSON.parse(e.details ?? "{}") as Record<string, unknown>);

const TEMPO = {
  map: { segments: [{ startBeat: 0, bpm: 120, meter: { num: 4, den: 4 } }] },
  bar1OffsetSec: 0.25,
};

let keys = { trackId: "", versionId: "" };
let drums = { trackId: "", versionId: "" };
let markers: Marker[] = [];

beforeAll(async () => {
  const f = matrix().find((x) => x.name === "imp_48000_s24_mono");
  if (!f) throw new Error("fixture");
  for (const name of ["Keys", "Drums"]) {
    const up = await tusUpload(t, admin, await fs.readFile(f.file), `${name}.wav`, {
      type: "newTrack",
      songId,
      name,
    });
    expect(up.status).toBe(200);
  }
  await runQueuedJobs(t);
  for (const tr of await tracksOf(admin)) {
    const ids = { trackId: tr.id, versionId: tr.current?.id ?? "" };
    if (tr.name === "Keys") keys = ids;
    if (tr.name === "Drums") drums = ids;
  }
  setProjectGrantRow(t.db, projectId, memberId, "editor", memberId);
  await call(t, updateSong, { params: { id: songId }, body: { key: "Am" } }, admin);
  expect(
    (await call(t, putSongTempo, { params: { id: songId }, body: TEMPO }, admin)).statusCode,
  ).toBe(200);
  for (const body of [
    { type: "marker", name: "Solo", color: "red", startSec: 1.25, anchor: "musical" },
    { type: "section", name: "Verse", color: "blue", startSec: 0.25, endSec: 4.25 },
  ] as const) {
    expect((await call(t, createMarker, { params: { id: songId }, body }, admin)).statusCode).toBe(
      200,
    );
  }
  markers = (await call(t, listSongMarkers, { params: { id: songId } }, admin)).json<{
    markers: Marker[];
  }>().markers;
}, 120_000);

const versions = () => ({
  [keys.trackId]: keys.versionId,
  [drums.trackId]: drums.versionId,
});

const bounce = (body: Record<string, unknown>) =>
  call(t, bounceSong, { params: { id: songId }, body: { versions: versions(), ...body } }, member);

const created = (res: Awaited<ReturnType<typeof bounce>>) => {
  expect(res.statusCode).toBe(200);
  return res.json<{ song: { id: string; key: string } }>().song;
};

const tempoOf = async (id: string) =>
  (await call(t, getSongTempo, { params: { id } }, admin)).json<{ tempo: SongTempo | null }>()
    .tempo;
const markersOf = async (id: string) =>
  (await call(t, listSongMarkers, { params: { id } }, admin)).json<{ markers: Marker[] }>().markers;

const mix = (over: Partial<MixerState> = {}): MixerState => ({
  tracks: { [keys.trackId]: s(), [drums.trackId]: s({ mute: true }) },
  ...over,
});

describe("bounce with practice settings (SPEC §30.7)", () => {
  it(
    "stretches an impulse at 3 s to 4 s at 75 %, scales tempo and markers, transposes the key",
    { timeout: 180_000 },
    async () => {
      const practice = { rate: 0.75, semitones: -2, cents: 0 };
      const song = created(
        await bounce({ title: "Slow", mix: mix({ practice }), applyPractice: true }),
      );
      expect(song.key).toBe("Gm");

      const payload = lastBouncePayload();
      expect(payload.practice).toEqual(practice);
      expect(payload.inputs).toEqual([
        expect.objectContaining({
          trackId: keys.trackId,
          stretch: {
            profile: "tonal",
            transpose: true,
            voiceBaseHz: 0,
            formant: false,
            formantShift: 0,
          },
        }),
      ]);
      expect(eventDetails("song.bounced", song.id)[0]).toMatchObject({
        practice,
        transposed: { [keys.trackId]: true },
      });

      const tempo = await tempoOf(song.id);
      expect(tempo?.bar1OffsetSec).toBeCloseTo(0.25 / 0.75, 9);
      expect(tempo?.map.segments[0]?.bpm).toBeCloseTo(90, 9);
      const copied = await markersOf(song.id);
      const solo = copied.find((m) => m.name === "Solo");
      const verse = copied.find((m) => m.name === "Verse");
      const src = markers.find((m) => m.name === "Solo");
      expect(solo?.startSec).toBeCloseTo(1.25 / 0.75, 9);
      expect(solo?.startBeat).toBe(src?.startBeat); // beats unchanged
      expect(verse?.startSec).toBeCloseTo(0.25 / 0.75, 9);
      expect(verse?.endSec).toBeCloseTo(4.25 / 0.75, 9);

      const pcm = await renderedPcm(song.id);
      expect(pcm.length).toBe(LENGTH / 0.75);
      for (const sec of [0.5, 3, 5.5]) {
        const want = (sec * SR) / 0.75;
        expect(Math.abs(peakAt(pcm, want - 4_000, want + 4_000) - want)).toBeLessThanOrEqual(400);
      }
      expect(eventDetails("version.rendered", song.id)[0]).toMatchObject({ stretched: 1 });
    },
  );

  it(
    "renders the click on the scaled grid, as long as the stretched song",
    {
      timeout: 180_000,
    },
    async () => {
      const song = created(
        await bounce({
          title: "Slow click",
          // Keys muted too: only the click sounds, so every sample can be compared.
          mix: {
            tracks: { [keys.trackId]: s({ mute: true }), [drums.trackId]: s({ mute: true }) },
            click: { gainDb: 0, sound: "beep", accent: true },
            practice: { rate: 0.75 },
          },
          includeClick: true,
          applyPractice: true,
        }),
      );
      const pcm = await renderedPcm(song.id);
      const length = LENGTH / 0.75;
      expect(pcm.length).toBe(length);
      const grid = compileTempo({
        map: { segments: [{ startBeat: 0, bpm: 90, meter: { num: 4, den: 4 }, barIndex: 0 }] },
        bar1OffsetSec: 0.25 / 0.75,
      });
      const pulses = clickFrames(grid, length, { subdivision: 1, compoundEighths: false });
      // Bar 1 at 1/3 s, a beat every 2/3 s.
      expect(Array.from(pulses.frames).slice(0, 3)).toEqual([16_000, 48_000, 80_000]);
      let worst = 0;
      pulses.frames.forEach((f, i) => {
        const sample = synthClick("beep", i % 4 === 0 ? 0 : 1);
        for (let j = -4; j < sample.length; j++) {
          const want = j < 0 ? 0 : (sample[j] ?? 0);
          worst = Math.max(worst, Math.abs((pcm[f + j] ?? 0) - want));
        }
      });
      expect(worst).toBeLessThan(2e-5);
    },
  );

  it(
    "keeps a drum track at its pitch and, at rate 1, mixes it straight from the source",
    { timeout: 180_000 },
    async () => {
      const onlyDrums = { [keys.trackId]: s({ mute: true }), [drums.trackId]: s() };
      const plain = created(
        await bounce({ title: "Drums", mix: { tracks: onlyDrums }, copyTempo: false }),
      );
      const plainPcm = await renderedPcm(plain.id);
      const song = created(
        await bounce({
          title: "Drums −2",
          mix: { tracks: onlyDrums, practice: { semitones: -2, cents: 8 } },
          applyPractice: true,
          copyTempo: false,
        }),
      );
      expect(song.key).toBe("Gm"); // −1.92 st rounds to −2
      expect(lastBouncePayload().inputs[0]?.stretch).toEqual({
        profile: "percussive",
        transpose: false,
        voiceBaseHz: 0,
        formant: false,
        formantShift: 0,
      });
      expect(eventDetails("song.bounced", song.id)[0]).toMatchObject({
        transposed: { [drums.trackId]: false },
      });
      const pcm = await renderedPcm(song.id);
      expect(eventDetails("version.rendered", song.id)[0]).toMatchObject({ stretched: 0 });
      expect(pcm).toEqual(plainPcm);
    },
  );

  it(
    "applies a personal formant shift alone, keeping time and key (v0.6.1)",
    { timeout: 180_000 },
    async () => {
      const song = created(
        await bounce({
          title: "Brighter keys",
          mix: mix({
            tracks: {
              [keys.trackId]: s({ formantMode: "preserve", formantShift: 3 }),
              [drums.trackId]: s({ mute: true }),
            },
          }),
          applyPractice: true,
          copyTempo: false,
        }),
      );
      expect(song.key).toBe("Am");
      expect(lastBouncePayload().inputs[0]?.stretch).toMatchObject({
        formant: true,
        formantShift: 3,
      });
      expect(eventDetails("song.bounced", song.id)[0]).toMatchObject({
        formants: { [keys.trackId]: { preserve: true, shift: 3 } },
      });
      const pcm = await renderedPcm(song.id);
      expect(eventDetails("version.rendered", song.id)[0]).toMatchObject({ stretched: 1 });
      expect(pcm.length).toBe(LENGTH);
      expect(Math.abs(peakAt(pcm, 3 * SR - 2000, 3 * SR + 2000) - 3 * SR)).toBeLessThan(400);
    },
  );

  it(
    "ignores the practice setting without applyPractice (older clients)",
    { timeout: 180_000 },
    async () => {
      const song = created(
        await bounce({ title: "As before", mix: mix({ practice: { rate: 0.5, semitones: 3 } }) }),
      );
      expect(song.key).toBe("Am");
      const payload = lastBouncePayload();
      expect(payload.practice).toBeUndefined();
      expect(payload.inputs[0]?.stretch).toBeUndefined();
      expect(eventDetails("song.bounced", song.id)[0]?.practice).toBeUndefined();
      expect((await tempoOf(song.id))?.map.segments[0]?.bpm).toBe(120);
      const pcm = await renderedPcm(song.id);
      expect(pcm.length).toBe(LENGTH);
      expect(peakAt(pcm, 3 * SR - 200, 3 * SR + 200)).toBe(3 * SR);
    },
  );
});
