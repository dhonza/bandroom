import {
  CAPTURE_CHUNK_FRAMES,
  FLOAT_WAV_HEADER_LENGTH,
  parseFloatWavHeader,
  parseStreamInfo,
  recoverFlac,
} from "@bandroom/audio-engine";
import type { TakeMessage } from "@bandroom/audio-engine";
import { describe, expect, it } from "vitest";
import { FakeTakeDir } from "./fakeTakeDir";
import { recoverTakes, TakeWriter } from "./takeWriter";
import { parseTakeMeta, type TakeContext, type WriterEvent } from "./takeTypes";

const ctx = (over: Partial<TakeContext> = {}): TakeContext => ({
  userId: "u1",
  mode: "song",
  songId: "s1",
  projectId: "p1",
  latencyFrames: 0,
  format: "flac",
  ...over,
});

function setup(opts: { metaEveryMs?: number } = {}) {
  const dir = new FakeTakeDir();
  const events: WriterEvent[] = [];
  const freed: Float32Array[] = [];
  let clock = 1_000;
  let ids = 0;
  const writer = new TakeWriter({
    dir: () => Promise.resolve(dir),
    emit: (e) => events.push(e),
    free: (d) => freed.push(d),
    now: () => clock,
    newId: () => `take-${String(++ids)}`,
    ...(opts.metaEveryMs !== undefined && { metaEveryMs: opts.metaEveryMs }),
  });
  const tick = (ms: number) => {
    clock += ms;
  };
  return { dir, events, freed, writer, tick };
}

/** Interleaved chunk of a quiet sine (any non-silent content), peak `amp`. */
function chunk(seq: number, frames: number, channels: number, amp = 0.25): TakeMessage {
  const data = new Float32Array(CAPTURE_CHUNK_FRAMES * channels);
  for (let i = 0; i < frames * channels; i++) data[i] = Math.sin((seq * frames + i) / 7) * amp;
  return { type: "take.chunk", seq, frames, channels, data };
}

const start = (startFrame: number, channels = 1): TakeMessage => ({
  type: "take.start",
  startFrame,
  channels,
  sampleRate: 48_000,
});

const end = (frames: number, startFrame = 0, channels = 1): TakeMessage => ({
  type: "take.end",
  startFrame,
  frames,
  channels,
  gapFrames: 0,
  endedBy: "user",
});

function finished(events: WriterEvent[]) {
  const e = events.find((x) => x.type === "finished");
  if (e?.type !== "finished") throw new Error("not finished");
  return e.meta;
}

describe("TakeWriter", () => {
  it("encodes a take into a complete FLAC file with its sidecar", async () => {
    const { dir, events, freed, writer } = setup();
    writer.prepare(ctx({ latencyFrames: 1000 }));
    writer.message(start(48_000, 2));
    for (let i = 0; i < 5; i++) writer.message(chunk(i, CAPTURE_CHUNK_FRAMES, 2));
    writer.message(chunk(5, 1000, 2));
    writer.message(end(5 * CAPTURE_CHUNK_FRAMES + 1000, 48_000, 2));
    await writer.idle();

    expect(events[0]).toEqual({ type: "started", takeId: "take-1" });
    const meta = finished(events);
    expect(meta).toMatchObject({
      takeId: "take-1",
      songId: "s1",
      startFrame: 48_000,
      latencyFrames: 1000,
      trimmedFrames: 0,
      channels: 2,
      frames: 5 * CAPTURE_CHUNK_FRAMES + 1000,
      status: "finished",
      endedBy: "user",
    });
    // Every buffer went back to the worklet's pool.
    expect(freed).toHaveLength(6);
    const bytes = dir.files.get("take-1.flac") ?? new Uint8Array();
    const info = parseStreamInfo(bytes.subarray(8, 42));
    expect(info.totalSamples).toBe(meta.frames);
    expect(info.channels).toBe(2);
    // Valid frames all the way through.
    expect(recoverFlac(bytes)).toMatchObject({
      validLength: bytes.length,
      totalSamples: meta.frames,
    });
    expect(parseTakeMeta(dir.text("take-1.json"))).toEqual(meta);
    expect(dir.locked.size).toBe(0);
  });

  it("writes a float take as a complete 32-bit float WAV, overs kept", async () => {
    const { dir, events, writer } = setup();
    writer.prepare(ctx({ format: "wav32f" }));
    writer.message(start(0, 2));
    const chunks = [chunk(0, CAPTURE_CHUNK_FRAMES, 2, 1.5), chunk(1, 1000, 2, 1.5)];
    for (const c of chunks) writer.message(structuredClone(c));
    writer.message(end(CAPTURE_CHUNK_FRAMES + 1000, 0, 2));
    await writer.idle();
    const meta = finished(events);
    expect(meta).toMatchObject({ format: "wav32f", frames: CAPTURE_CHUNK_FRAMES + 1000 });
    expect(dir.files.has("take-1.flac")).toBe(false);
    const bytes = dir.files.get("take-1.wav") ?? new Uint8Array();
    expect(bytes.length).toBe(FLOAT_WAV_HEADER_LENGTH + meta.frames * 8);
    expect(parseFloatWavHeader(bytes)).toEqual({
      channels: 2,
      sampleRate: 48_000,
      frames: meta.frames,
    });
    const data = new Float32Array(bytes.slice(FLOAT_WAV_HEADER_LENGTH).buffer);
    const first = chunks[0]?.type === "take.chunk" ? chunks[0].data : new Float32Array();
    expect(data.subarray(0, 100)).toEqual(first.subarray(0, 100));
    // The peak keeps the overs in float.
    expect(meta.peak).toBeGreaterThan(1.4);
    expect(parseTakeMeta(dir.text("take-1.json"))).toEqual(meta);
  });

  it("tracks the take's peak, clipped at full scale for FLAC", async () => {
    const { events, writer } = setup();
    writer.prepare(ctx());
    writer.message(start(0));
    writer.message(chunk(0, 1000, 1, 0.5));
    writer.message(end(1000));
    await writer.idle();
    expect(finished(events).peak).toBeCloseTo(0.5, 2);
    writer.prepare(ctx());
    writer.message(start(0));
    writer.message(chunk(0, 1000, 1, 2));
    writer.message(end(1000));
    await writer.idle();
    expect(events.filter((e) => e.type === "finished").at(-1)).toMatchObject({
      meta: { peak: 1 },
    });
  });

  it("drops the head the latency reaches before the song start", async () => {
    const { events, writer } = setup();
    writer.prepare(ctx({ latencyFrames: 5000 }));
    writer.message(start(0));
    writer.message(chunk(0, CAPTURE_CHUNK_FRAMES, 1));
    writer.message(chunk(1, CAPTURE_CHUNK_FRAMES, 1));
    writer.message({ type: "take.gap", frames: 2000 });
    writer.message({ ...end(2 * CAPTURE_CHUNK_FRAMES + 2000), gapFrames: 2000 } as TakeMessage);
    await writer.idle();
    const meta = finished(events);
    expect(meta.trimmedFrames).toBe(5000);
    expect(meta.frames).toBe(2 * CAPTURE_CHUNK_FRAMES + 2000 - 5000);
    expect(meta.gapFrames).toBe(2000);
  });

  it("trims across a gap too", async () => {
    const { events, writer } = setup();
    writer.prepare(ctx({ latencyFrames: 3000 }));
    writer.message(start(1000));
    writer.message({ type: "take.gap", frames: 1500 });
    writer.message(chunk(0, 4000, 1));
    writer.message(end(5500, 1000));
    await writer.idle();
    expect(finished(events)).toMatchObject({ trimmedFrames: 2000, frames: 3500 });
  });

  it("waits for the context when the take starts first", async () => {
    const { events, writer, freed } = setup();
    writer.message(start(0));
    writer.message(chunk(0, 1000, 1));
    expect(freed).toHaveLength(0);
    writer.prepare(ctx({ projectId: "p9", mode: "project", songId: null }));
    writer.message(end(1000));
    await writer.idle();
    expect(finished(events)).toMatchObject({ projectId: "p9", mode: "project", frames: 1000 });
    expect(freed).toHaveLength(1);
  });

  it("keeps nothing for a take that never began or holds no audio", async () => {
    const { dir, events, writer } = setup();
    writer.prepare(ctx());
    writer.message(end(0, -1));
    await writer.idle();
    expect(events).toEqual([{ type: "empty" }]);

    writer.prepare(ctx({ latencyFrames: 10_000 }));
    writer.message(start(0));
    writer.message(chunk(0, 2000, 1));
    writer.message(end(2000));
    await writer.idle();
    expect(events.at(-1)).toEqual({ type: "empty" });
    expect(dir.files.size).toBe(0);

    // Without any context (the end of a take that never began, no Record press seen).
    writer.message(end(0, -1));
    await writer.idle();
    expect(events.at(-1)).toEqual({ type: "empty" });
  });

  it("refreshes the sidecar while recording", async () => {
    const { dir, writer, tick } = setup({ metaEveryMs: 5000 });
    writer.prepare(ctx());
    writer.message(start(0));
    writer.message(chunk(0, CAPTURE_CHUNK_FRAMES, 1));
    await writer.idle();
    expect(parseTakeMeta(dir.text("take-1.json"))?.frames).toBe(0);
    tick(6000);
    writer.message(chunk(1, CAPTURE_CHUNK_FRAMES, 1));
    await writer.idle();
    const meta = parseTakeMeta(dir.text("take-1.json"));
    expect(meta).toMatchObject({ status: "recording", frames: 2 * CAPTURE_CHUNK_FRAMES });
  });

  it("finalizes when the context went away before the end", async () => {
    const { events, writer, freed } = setup();
    writer.prepare(ctx());
    writer.message(start(0));
    writer.message(chunk(0, 3000, 1));
    writer.finalize("rebuilt");
    await writer.idle();
    expect(finished(events)).toMatchObject({ frames: 3000, endedBy: "rebuilt" });
    // Late messages of that take are dropped (their buffers go back) and never reach the next.
    const late = chunk(1, 500, 1);
    writer.message(late);
    writer.message(end(3500));
    await writer.idle();
    expect(freed.at(-1)).toBe(late.type === "take.chunk" ? late.data : null);
    writer.prepare(ctx());
    writer.message(start(0));
    writer.message(chunk(0, 100, 1));
    writer.message(end(100));
    await writer.idle();
    expect(events.filter((e) => e.type === "finished").at(-1)).toMatchObject({
      type: "finished",
      meta: { frames: 100 },
    });
  });

  it("reports a failed write and keeps what it can for the recovery", async () => {
    const { dir, events, writer } = setup();
    writer.prepare(ctx());
    writer.message(start(0));
    await writer.idle();
    // Storage full: every further write throws.
    const handleWrite = () => {
      throw new Error("QuotaExceededError");
    };
    (writer as unknown as { take: { file: { write: () => never } } }).take.file.write = handleWrite;
    writer.message(chunk(0, CAPTURE_CHUNK_FRAMES, 1));
    writer.message(chunk(1, CAPTURE_CHUNK_FRAMES, 1));
    writer.message(end(2 * CAPTURE_CHUNK_FRAMES));
    await writer.idle();
    const failed = events.find((e) => e.type === "failed");
    expect(failed).toMatchObject({ type: "failed", meta: { takeId: "take-1" } });
    expect(events.some((e) => e.type === "finished")).toBe(false);
    expect(parseTakeMeta(dir.text("take-1.json"))?.status).toBe("recording");
  });
});

describe("recoverTakes", () => {
  async function crashed(frames: number, format: TakeContext["format"] = "flac") {
    const s = setup({ metaEveryMs: 0 });
    s.writer.prepare(ctx({ latencyFrames: 480, format }));
    s.writer.message(start(96_000));
    let left = frames;
    let seq = 0;
    while (left > 0) {
      const n = Math.min(CAPTURE_CHUNK_FRAMES, left);
      s.writer.message(chunk(seq++, n, 1));
      left -= n;
    }
    await s.writer.idle();
    // The page went away: its handles are gone with it.
    s.dir.locked.clear();
    return s;
  }

  it("finishes a take a crash left behind", async () => {
    const { dir } = await crashed(5 * CAPTURE_CHUNK_FRAMES + 100);
    // A cut-off last write.
    const bytes = dir.files.get("take-1.flac") ?? new Uint8Array();
    dir.files.set("take-1.flac", bytes.subarray(0, bytes.length - 3));
    const takes = await recoverTakes(dir, { now: () => 9 });
    expect(takes).toHaveLength(1);
    const meta = takes[0];
    // The encoder holds the unfinished block; complete frames are kept, the cut one dropped.
    expect(meta).toMatchObject({ takeId: "take-1", status: "finished", recovered: true });
    // The peak may miss the end: no auto level for a recovered take.
    expect(meta).not.toHaveProperty("peak");
    expect(meta?.frames).toBe(4 * CAPTURE_CHUNK_FRAMES);
    const fixed = dir.files.get("take-1.flac") ?? new Uint8Array();
    expect(parseStreamInfo(fixed.subarray(8, 42)).totalSamples).toBe(meta?.frames);
    expect(recoverFlac(fixed).validLength).toBe(fixed.length);
    expect(parseTakeMeta(dir.text("take-1.json"))).toEqual(meta);
    expect(dir.locked.size).toBe(0);
  });

  it("finishes a float take a crash left behind (whole frames from the file length)", async () => {
    const { dir } = await crashed(3 * CAPTURE_CHUNK_FRAMES + 100, "wav32f");
    const bytes = dir.files.get("take-1.wav") ?? new Uint8Array();
    expect(parseFloatWavHeader(bytes)?.frames).toBe(0);
    // A cut-off last write.
    dir.files.set("take-1.wav", bytes.subarray(0, bytes.length - 3));
    const takes = await recoverTakes(dir, { now: () => 9 });
    const meta = takes[0];
    expect(meta).toMatchObject({ format: "wav32f", status: "finished", recovered: true });
    expect(meta).not.toHaveProperty("peak");
    expect(meta?.frames).toBe(3 * CAPTURE_CHUNK_FRAMES + 99);
    const fixed = dir.files.get("take-1.wav") ?? new Uint8Array();
    expect(fixed.length).toBe(FLOAT_WAV_HEADER_LENGTH + (meta?.frames ?? 0) * 4);
    expect(parseFloatWavHeader(fixed)?.frames).toBe(meta?.frames);
    expect(parseTakeMeta(dir.text("take-1.json"))).toEqual(meta);
    expect(dir.locked.size).toBe(0);
  });

  it("reads old sidecars without a format as FLAC", () => {
    const meta = parseTakeMeta(
      JSON.stringify({
        v: 1,
        takeId: "a",
        userId: "u",
        projectId: "p",
        startFrame: 0,
        frames: 1,
        channels: 1,
      }),
    );
    expect(meta?.format).toBe("flac");
  });

  it("lists finished takes, skips held and active ones, removes empty and orphan files", async () => {
    const { dir } = await crashed(100); // no complete frame
    dir.files.set("orphan.flac", new Uint8Array(10));
    dir.files.set("orphan2.wav", new Uint8Array(10));
    dir.files.set("junk.json", new TextEncoder().encode("{}"));
    expect(await recoverTakes(dir, { now: () => 1 })).toEqual([]);
    expect([...dir.files.keys()]).toEqual([]);

    const b = await crashed(2 * CAPTURE_CHUNK_FRAMES);
    b.dir.held.add("take-1.json");
    expect(await recoverTakes(b.dir, { now: () => 1 })).toEqual([]);
    b.dir.held.clear();
    expect(await recoverTakes(b.dir, { now: () => 1, skip: new Set(["take-1"]) })).toEqual([]);
    const done = await recoverTakes(b.dir, { now: () => 1 });
    expect(done.map((m) => m.takeId)).toEqual(["take-1"]);
    // Already finished: listed as it is.
    expect(await recoverTakes(b.dir, { now: () => 2 })).toEqual(done);
  });
});
