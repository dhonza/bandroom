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
} from "@bandroom/server-core";
import {
  bounceSong,
  clickFrames,
  compileTempo,
  createMarker,
  deleteSongTempo,
  getSongTempo,
  listSongMarkers,
  listSongTracks,
  putSongTempo,
  synthClick,
  updateSong,
  type EventAction,
  type Marker,
  type MixerTrackState,
  type SongTempo,
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

/**
 * Bounce options (SPEC §5.5, owner decisions 2026-10-07): the click rendered with real ffmpeg
 * matches the engine's click sample for sample; the tempo map and markers are copied with their
 * events; with the options off nothing is copied.
 */

setupUploadFixtures();

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
    // The left channel only: a bounce with L = R is stored as dual-mono (one channel).
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

const TEMPO = {
  map: { segments: [{ startBeat: 0, bpm: 120, meter: { num: 4, den: 4 } }] },
  // Bar 1 at 0.25 s: clicks at 0.25 + k · 0.5 s, between the fixture's impulses.
  bar1OffsetSec: 0.25,
};
const LENGTH = 6 * 48_000;

let trackId = "";
let versionId = "";
let markers: Marker[] = [];

beforeAll(async () => {
  const f = matrix().find((x) => x.name === "imp_48000_s24_mono");
  if (!f) throw new Error("fixture");
  const up = await tusUpload(t, admin, await fs.readFile(f.file), "Mono.wav", {
    type: "newTrack",
    songId,
    name: "Mono",
  });
  expect(up.status).toBe(200);
  await runQueuedJobs(t);
  const [tr] = await tracksOf(admin);
  trackId = tr?.id ?? "";
  versionId = tr?.current?.id ?? "";
  setProjectGrantRow(t.db, projectId, memberId, "editor", memberId);
  await call(
    t,
    updateSong,
    { params: { id: songId }, body: { subtitle: "Live take", key: "Am" } },
    admin,
  );
  const put = await call(t, putSongTempo, { params: { id: songId }, body: TEMPO }, admin);
  expect(put.statusCode).toBe(200);
  for (const body of [
    { type: "marker", name: "Solo", color: "red", startSec: 1.25, anchor: "musical" },
    { type: "section", name: "Verse", color: "blue", startSec: 0.25, endSec: 4.25 },
  ] as const) {
    const res = await call(t, createMarker, { params: { id: songId }, body }, admin);
    expect(res.statusCode).toBe(200);
  }
  markers = (await call(t, listSongMarkers, { params: { id: songId } }, admin)).json<{
    markers: Marker[];
  }>().markers;
  expect(markers).toHaveLength(2);
}, 120_000);

const bounce = (body: Record<string, unknown>) =>
  call(
    t,
    bounceSong,
    { params: { id: songId }, body: { versions: { [trackId]: versionId }, ...body } },
    member,
  );

const tempoOf = async (id: string) =>
  (await call(t, getSongTempo, { params: { id } }, admin)).json<{ tempo: SongTempo | null }>()
    .tempo;
const markersOf = async (id: string) =>
  (await call(t, listSongMarkers, { params: { id } }, admin)).json<{ markers: Marker[] }>().markers;

describe("bounce options (SPEC §5.5)", () => {
  it(
    "renders the click at the tempo map's frames with its volume and sound; copies tempo and markers",
    { timeout: 180_000 },
    async () => {
      const res = await bounce({
        title: "With click",
        // The click is muted in the Player: "Include click" renders it anyway.
        mix: {
          tracks: { [trackId]: s({ gainDb: -6 }) },
          click: { enabled: false, gainDb: -12, sound: "beep", accent: true },
        },
        includeClick: true,
      });
      expect(res.statusCode).toBe(200);
      const created = res.json<{ song: { id: string; subtitle: string; key: string } }>().song;
      expect(created.subtitle).toBe("Live take");
      expect(created.key).toBe("Am");

      // Tempo map and markers copied at the same positions, by the user who bounced.
      const tempo = await tempoOf(created.id);
      expect(tempo?.bar1OffsetSec).toBe(TEMPO.bar1OffsetSec);
      expect(tempo?.map).toEqual((await tempoOf(songId))?.map);
      const copied = await markersOf(created.id);
      const strip = (m: Marker) => [m.type, m.name, m.color, m.startSec, m.endSec, m.anchor];
      expect(copied.map(strip)).toEqual(markers.map(strip));
      expect(copied.every((m) => m.createdBy === memberId)).toBe(true);
      const details = (action: EventAction) =>
        listEvents(t.db, { action })
          .filter((e) => e.songId === created.id)
          .map((e) => JSON.parse(e.details ?? "{}") as Record<string, unknown>);
      const [bounced] = details("song.bounced");
      expect(bounced).toMatchObject({ includeClick: true, copyTempo: true, copyMarkers: true });
      const batchId = bounced?.batchId;
      expect(typeof batchId).toBe("string");
      expect(details("tempo.changed")).toEqual([
        expect.objectContaining({ action: "copy", sourceSongId: songId, batchId }),
      ]);
      expect(details("marker.created")).toEqual([
        expect.objectContaining({ name: "Solo", batchId }),
      ]);
      expect(details("section.created")).toEqual([
        expect.objectContaining({ name: "Verse", batchId }),
      ]);

      const pcm = await renderedPcm(created.id);
      expect(pcm.length).toBe(LENGTH);
      // Every click as the engine plays it: the same frames, the same samples at −12 dB.
      const grid = compileTempo({ map: tempo?.map ?? { segments: [] }, bar1OffsetSec: 0.25 });
      const pulses = clickFrames(grid, LENGTH, { subdivision: 1, compoundEighths: false });
      expect(Array.from(pulses.frames)).toEqual(
        Array.from({ length: 12 }, (_, k) => 12_000 + 24_000 * k),
      );
      const g = 10 ** (-12 / 20);
      let worst = 0;
      pulses.frames.forEach((f, i) => {
        const sample = synthClick("beep", i % 4 === 0 ? 0 : 1);
        for (let j = -4; j < sample.length; j++) {
          const want = j < 0 ? 0 : (sample[j] ?? 0) * g;
          worst = Math.max(worst, Math.abs((pcm[f + j] ?? 0) - want));
        }
      });
      expect(worst).toBeLessThan(2e-5);
      // The track's impulses at −6 dB are there too (mono, centred: −3 dB per side).
      expect(pcm[24_000] ?? 0).toBeCloseTo(0.9 * 10 ** (-6 / 20) * Math.SQRT1_2, 3);
    },
  );

  it(
    "a soloed click silences the unsoloed tracks, as in the Player",
    { timeout: 180_000 },
    async () => {
      const res = await bounce({
        title: "Click solo",
        mix: { tracks: { [trackId]: s() }, click: { solo: true, gainDb: 0, sound: "woodblock" } },
        includeClick: true,
        copyTempo: false,
        copyMarkers: false,
      });
      expect(res.statusCode).toBe(200);
      const pcm = await renderedPcm(res.json<{ song: { id: string } }>().song.id);
      expect(Math.abs(pcm[24_000] ?? 1)).toBeLessThan(1e-4); // the impulse is gone
      const accent = synthClick("woodblock", 0);
      expect(pcm[12_000 + 100] ?? 0).toBeCloseTo(accent[100] ?? 0, 4);
    },
  );

  it(
    "with the options off copies no tempo map and no markers, and renders no click",
    { timeout: 180_000 },
    async () => {
      const res = await bounce({
        title: "Plain",
        mix: { tracks: { [trackId]: s({ gainDb: -6 }) }, click: { enabled: true } },
        copyTempo: false,
        copyMarkers: false,
        includeClick: false,
      });
      expect(res.statusCode).toBe(200);
      const id = res.json<{ song: { id: string } }>().song.id;
      expect(await tempoOf(id)).toBeNull();
      expect(await markersOf(id)).toEqual([]);
      for (const action of ["tempo.changed", "marker.created", "section.created"] as const)
        expect(listEvents(t.db, { action }).filter((e) => e.songId === id)).toEqual([]);
      const pcm = await renderedPcm(id);
      let clicks = 0;
      for (let i = 0; i < 1000; i++) clicks += Math.abs(pcm[12_000 + i] ?? 0);
      expect(clicks).toBeLessThan(1e-3);
    },
  );

  it(
    "renders lossy only at the chosen preset when asked (SPEC §28.2)",
    { timeout: 180_000 },
    async () => {
      const res = await bounce({
        title: "Lossy",
        mix: { tracks: { [trackId]: s() } },
        copyTempo: false,
        copyMarkers: false,
        options: { lossyOnly: true, quality: "veryHigh" },
      });
      expect(res.statusCode).toBe(200);
      const id = res.json<{ song: { id: string } }>().song.id;
      expect(await runQueuedJobs(t)).toEqual(["done", "done"]);
      const [track] = await songTracks(id);
      // The fixture is mono: the mono rate of the preset.
      expect(track?.current).toMatchObject({
        archived: { reason: "upload" },
        variants: { flac: null, opus: { bitrate: 96, quality: "veryHigh" } },
      });
      const [bounced] = listEvents(t.db, { action: "song.bounced" }).filter((e) => e.songId === id);
      expect(JSON.parse(bounced?.details ?? "{}")).toMatchObject({
        options: { lossyOnly: true, quality: "veryHigh" },
      });
    },
  );

  it("refuses the click without a tempo map", async () => {
    expect(
      (await call(t, deleteSongTempo, { params: { id: songId } }, admin)).statusCode,
    ).toBeLessThan(300);
    const res = await bounce({ title: "No tempo", mix: { tracks: {} }, includeClick: true });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string }>().code).toBe("BOUNCE_INVALID");
  });
});
