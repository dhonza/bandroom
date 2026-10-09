import type { TakeEndReason, TakeMessage } from "@bandroom/audio-engine";
// The FLAC and WAV parts only: the worker bundle stays small.
import { FLAC_STREAMINFO_OFFSET, FlacEncoder, FlacRecovery } from "@bandroom/audio-engine/flac";
import {
  FLOAT_WAV_HEADER_LENGTH,
  FloatWavWriter,
  recoverFloatWav,
} from "@bandroom/audio-engine/wav";
import {
  parseTakeMeta,
  TAKE_EXTENSIONS,
  takeFileName,
  takeMetaName,
  type TakeContext,
  type TakeFormat,
  type TakeMeta,
  type WriterEvent,
} from "./takeTypes";

/**
 * The take writer (SPEC §9), run in a worker: it receives the mixer's capture chunks over the
 * take port, encodes them to FLAC (or a 32-bit float WAV) and appends them to the take's file in OPFS, keeping the JSON
 * sidecar up to date. Pure logic over a small file-system interface, so it runs in Node tests.
 */

/** The part of `FileSystemSyncAccessHandle` the writer uses (Safari < 16.4 has async ones). */
export interface SyncHandle {
  read(buffer: Uint8Array, opts: { at: number }): number;
  write(buffer: Uint8Array, opts: { at: number }): number;
  truncate(size: number): void | Promise<void>;
  getSize(): number | Promise<number>;
  flush(): void | Promise<void>;
  close(): void | Promise<void>;
}

/** A user's take folder (`takes/<userId>` in OPFS). */
export interface TakeDir {
  /** Opens (creating) a file for synchronous access; fails while another handle holds it. */
  open(name: string): Promise<SyncHandle>;
  remove(name: string): Promise<void>;
  list(): Promise<string[]>;
}

export interface TakeWriterDeps {
  dir: (userId: string) => Promise<TakeDir>;
  emit: (e: WriterEvent) => void;
  /** Gives a chunk's buffer back to the worklet's pool. */
  free: (data: Float32Array) => void;
  now: () => number;
  newId: () => string;
  /** Sidecar refresh interval while recording (default 5 s). */
  metaEveryMs?: number;
}

const META_EVERY_MS = 5000;
/** Planar buffer sets kept for reuse. */
const POOL_MAX = 8;

interface Planar {
  set: Float32Array[];
  frames: number;
  /** Loudest sample of the chunk (unclipped). */
  peak: number;
}

/** The encoder of a take format (FLAC or float WAV share this shape). */
interface TakeEncoder {
  readonly totalSamples: number;
  header(): Uint8Array;
  encode(planar: readonly Float32Array[], frames?: number): Uint8Array;
  finish(): Uint8Array;
  /** The header part to write once the take is complete. */
  final(): { at: number; bytes: Uint8Array };
}

function takeEncoder(format: TakeFormat, channels: number): TakeEncoder {
  if (format === "wav32f") {
    const w = new FloatWavWriter({ channels });
    return {
      get totalSamples() {
        return w.totalSamples;
      },
      header: () => w.header(),
      encode: (p, n) => w.encode(p, n),
      finish: () => w.finish(),
      final: () => ({ at: 0, bytes: w.finalHeader() }),
    };
  }
  const f = new FlacEncoder({ channels });
  return {
    get totalSamples() {
      return f.totalSamples;
    },
    header: () => f.header(),
    encode: (p, n) => f.encode(p, n),
    finish: () => f.finish(),
    final: () => ({ at: FLAC_STREAMINFO_OFFSET, bytes: f.streamInfo() }),
  };
}
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function writeText(h: SyncHandle, text: string): Promise<void> {
  const bytes = encoder.encode(text);
  await h.truncate(0);
  h.write(bytes, { at: 0 });
  await h.flush();
}

export async function readText(h: SyncHandle): Promise<string> {
  const size = await h.getSize();
  const buf = new Uint8Array(size);
  h.read(buf, { at: 0 });
  return decoder.decode(buf);
}

interface OpenTake {
  meta: TakeMeta;
  dir: TakeDir;
  file: SyncHandle;
  sidecar: SyncHandle;
  encoder: TakeEncoder;
  /** File position of the next write. */
  pos: number;
  lastMeta: number;
  failed: boolean;
}

export class TakeWriter {
  private ctx: TakeContext | null = null;
  /** Messages that came before the take's context (`prepare`). */
  private waiting: TakeMessage[] = [];
  private take: OpenTake | null = null;
  private chain: Promise<void> = Promise.resolve();
  /** Head frames still to drop (tracked as messages arrive). */
  private trimLeft = 0;
  private pool: Float32Array[][] = [];

  constructor(private readonly deps: TakeWriterDeps) {}

  /** The take being written (recovery leaves it alone). */
  get activeTakeId(): string | null {
    return this.take?.meta.takeId ?? null;
  }

  /** Resolves once everything received so far is handled (tests, recovery). */
  idle(): Promise<void> {
    return this.chain;
  }

  /** The next take's context: Record was pressed. */
  prepare(ctx: TakeContext): void {
    this.ctx = ctx;
    const queued = this.waiting;
    this.waiting = [];
    for (const m of queued) this.message(m);
  }

  /** A message from the take port. */
  message(m: TakeMessage): void {
    if (!this.ctx && !this.take) {
      const started = m.type === "take.start" || this.waiting.some((w) => w.type === "take.start");
      if (!started) {
        // Left over from a take already finished (finalized before its end arrived), or the end
        // of a take that never began (Stop during the count-in): nothing to keep.
        if (m.type === "take.chunk") this.deps.free(m.data);
        if (m.type === "take.end") this.deps.emit({ type: "empty" });
        return;
      }
      // Record was pressed but its context has not arrived yet: wait for it.
      this.waiting.push(m);
      return;
    }
    if (m.type === "take.chunk") {
      // Copy out and return the buffer at once, so the worklet's pool stays full.
      const p = this.copyChunk(m.data, m.frames, m.channels);
      this.deps.free(m.data);
      this.run(() => this.encodePlanar(p));
      return;
    }
    if (m.type === "take.start") {
      // The head trim is known now: the latency reaching back before the song start.
      this.trimLeft = Math.max(0, Math.round(this.ctx?.latencyFrames ?? 0) - m.startFrame);
      const ctx = this.ctx;
      this.run(() => this.start(m.startFrame, m.channels, ctx));
      return;
    }
    if (m.type === "take.gap") {
      const skip = Math.min(this.trimLeft, m.frames);
      this.trimLeft -= skip;
      this.run(() => this.silence(m.frames, m.frames - skip));
      return;
    }
    this.ctx = null;
    this.run(() => this.finish(m.endedBy, m.gapFrames, m.startFrame < 0));
  }

  /** The audio context went away before the worklet confirmed the end. */
  finalize(endedBy: TakeEndReason): void {
    this.waiting = [];
    this.ctx = null;
    this.run(() => this.finish(endedBy, null));
  }

  private run(fn: () => Promise<void>): void {
    this.chain = this.chain.then(fn).catch((err: unknown) => {
      void this.fail(err);
    });
  }

  private async start(
    startFrame: number,
    channels: number,
    ctx: TakeContext | null,
  ): Promise<void> {
    if (!ctx) return;
    if (this.take) await this.finish("reloaded", null);
    const takeId = this.deps.newId();
    const now = this.deps.now();
    const trim = Math.max(0, Math.round(ctx.latencyFrames - startFrame));
    const meta: TakeMeta = {
      v: 1,
      takeId,
      userId: ctx.userId,
      mode: ctx.mode,
      songId: ctx.songId,
      projectId: ctx.projectId,
      startFrame,
      latencyFrames: ctx.latencyFrames,
      trimmedFrames: trim,
      channels,
      format: ctx.format,
      frames: 0,
      peak: 0,
      status: "recording",
      endedBy: null,
      gapFrames: 0,
      createdAt: now,
      updatedAt: now,
    };
    const dir = await this.deps.dir(ctx.userId);
    const file = await dir.open(takeFileName(takeId, ctx.format));
    const sidecar = await dir.open(takeMetaName(takeId));
    const enc = takeEncoder(ctx.format, channels);
    await file.truncate(0);
    const header = enc.header();
    file.write(header, { at: 0 });
    this.take = {
      meta,
      dir,
      file,
      sidecar,
      encoder: enc,
      pos: header.length,
      lastMeta: now,
      failed: false,
    };
    await writeText(sidecar, JSON.stringify(meta));
    this.deps.emit({ type: "started", takeId });
  }

  /**
   * Interleaved → planar, dropping what is left of the head trim, into a pooled buffer set (back
   * in the pool once encoded). Returns the set and the frames kept.
   */
  private copyChunk(data: Float32Array, frames: number, channels: number): Planar {
    const skip = Math.min(this.trimLeft, frames);
    this.trimLeft -= skip;
    const n = frames - skip;
    let set = this.pool.pop();
    if (!set || set.length !== channels || (set[0]?.length ?? 0) < n) {
      set = Array.from({ length: channels }, () => new Float32Array(Math.max(n, 4096)));
    }
    let peak = 0;
    for (let c = 0; c < channels; c++) {
      const out = set[c] as Float32Array;
      for (let i = 0; i < n; i++) {
        const x = data[(skip + i) * channels + c] as number;
        out[i] = x;
        const a = x < 0 ? -x : x;
        if (a > peak) peak = a;
      }
    }
    return { set, frames: n, peak };
  }

  private async encodePlanar(p: Planar): Promise<void> {
    const t = this.take;
    try {
      if (!t || t.failed || p.frames === 0) return;
      this.append(t, t.encoder.encode(p.set, p.frames));
      // FLAC clips at full scale; a float take keeps the overs.
      const peak = t.meta.format === "flac" ? Math.min(1, p.peak) : p.peak;
      if (peak > (t.meta.peak ?? 0)) t.meta.peak = peak;
      await this.maybeMeta(t);
    } finally {
      if (this.pool.length < POOL_MAX) this.pool.push(p.set);
    }
  }

  /** `frames` lost frames (`kept` of them after the head trim) are written as silence. */
  private async silence(frames: number, kept: number): Promise<void> {
    const t = this.take;
    if (!t || t.failed) return;
    t.meta.gapFrames += frames;
    let left = kept;
    const block = 4096;
    const zeros = Array.from({ length: t.meta.channels }, () => new Float32Array(block));
    while (left > 0) {
      const n = Math.min(block, left);
      this.append(t, t.encoder.encode(zeros, n));
      left -= n;
    }
    await this.maybeMeta(t);
  }

  private append(t: OpenTake, bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    t.file.write(bytes, { at: t.pos });
    t.pos += bytes.length;
  }

  private async maybeMeta(t: OpenTake): Promise<void> {
    const now = this.deps.now();
    if (now - t.lastMeta < (this.deps.metaEveryMs ?? META_EVERY_MS)) return;
    t.lastMeta = now;
    t.meta.frames = t.encoder.totalSamples;
    t.meta.updatedAt = now;
    await t.file.flush();
    await writeText(t.sidecar, JSON.stringify(t.meta));
  }

  private async finish(
    endedBy: TakeEndReason,
    gapFrames: number | null,
    neverBegan = false,
  ): Promise<void> {
    const t = this.take;
    if (!t) {
      if (neverBegan) this.deps.emit({ type: "empty" });
      return;
    }
    this.take = null;
    if (t.failed) return;
    this.append(t, t.encoder.finish());
    const frames = t.encoder.totalSamples;
    if (frames === 0) {
      await closeQuietly(t.file);
      await closeQuietly(t.sidecar);
      await t.dir.remove(takeFileName(t.meta.takeId, t.meta.format)).catch(() => undefined);
      await t.dir.remove(takeMetaName(t.meta.takeId)).catch(() => undefined);
      this.deps.emit({ type: "empty" });
      return;
    }
    const final = t.encoder.final();
    t.file.write(final.bytes, { at: final.at });
    await t.file.flush();
    await t.file.close();
    const meta: TakeMeta = {
      ...t.meta,
      frames,
      status: "finished",
      endedBy,
      gapFrames: gapFrames ?? t.meta.gapFrames,
      updatedAt: this.deps.now(),
    };
    await writeText(t.sidecar, JSON.stringify(meta));
    await t.sidecar.close();
    this.deps.emit({ type: "finished", meta });
  }

  private async fail(err: unknown): Promise<void> {
    const t = this.take;
    const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    if (t && !t.failed) {
      // What was written stays for the recovery (the sidecar still says "recording").
      t.failed = true;
      await closeQuietly(t.file);
      await closeQuietly(t.sidecar);
    }
    this.deps.emit({ type: "failed", error, meta: t ? { ...t.meta } : null });
  }
}

async function closeQuietly(h: SyncHandle): Promise<void> {
  try {
    await h.close();
  } catch {
    // already closed
  }
}

// --- Recovery -------------------------------------------------------------------------------------

const READ_CHUNK = 1 << 20;

/**
 * Fixes an unfinished take file in place: cut after its last complete frame, with a STREAMINFO
 * (FLAC) or header sizes (float WAV) for what it holds. Returns the frames kept; throws when the
 * file has no readable header.
 */
async function repairTakeFile(file: SyncHandle, format: TakeFormat): Promise<number> {
  const size = await file.getSize();
  if (format === "wav32f") {
    const head = new Uint8Array(FLOAT_WAV_HEADER_LENGTH);
    file.read(head, { at: 0 });
    const r = recoverFloatWav(head, size);
    if (r.frames === 0) return 0;
    await file.truncate(r.validLength);
    file.write(r.header, { at: 0 });
    await file.flush();
    return r.frames;
  }
  const rec = new FlacRecovery();
  const buf = new Uint8Array(READ_CHUNK);
  for (let at = 0; at < size; at += READ_CHUNK) {
    const n = file.read(buf, { at });
    if (n <= 0) break;
    rec.push(buf.subarray(0, n));
  }
  const r = rec.finish();
  if (r.frames === 0) return 0;
  await file.truncate(r.validLength);
  file.write(r.streamInfo, { at: FLAC_STREAMINFO_OFFSET });
  await file.flush();
  return r.totalSamples;
}

/**
 * Finishes the takes a crash or reload left unfinished (sidecar status "recording"): the file is
 * cut after its last complete frame and gets a STREAMINFO (FLAC) or header sizes (float WAV) for
 * what it holds (SPEC §9). Their peak is dropped (it may miss the end), so no auto level. Takes
 * held open elsewhere (another tab recording) and `skip` are left alone; empty takes and files
 * without a partner are removed. Returns every finished take of the user on this device.
 */
export async function recoverTakes(
  dir: TakeDir,
  opts: { skip?: ReadonlySet<string>; now: () => number },
): Promise<TakeMeta[]> {
  const names = await dir.list();
  const skip = opts.skip ?? new Set<string>();
  const out: TakeMeta[] = [];
  const metas = new Set(names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)));
  for (const name of names) {
    const ext = TAKE_EXTENSIONS.find((e) => name.endsWith(`.${e}`));
    if (!ext) continue;
    const id = name.slice(0, -(ext.length + 1));
    if (!metas.has(id) && !skip.has(id)) await dir.remove(name).catch(() => undefined);
  }
  for (const id of metas) {
    if (skip.has(id)) continue;
    let sidecar: SyncHandle;
    try {
      sidecar = await dir.open(takeMetaName(id));
    } catch {
      continue; // held by a recording in another tab
    }
    try {
      const meta = parseTakeMeta(await readText(sidecar));
      if (!meta || !names.includes(takeFileName(id, meta.format))) {
        await closeQuietly(sidecar);
        await dir.remove(takeMetaName(id)).catch(() => undefined);
        for (const ext of TAKE_EXTENSIONS) {
          await dir.remove(`${id}.${ext}`).catch(() => undefined);
        }
        continue;
      }
      if (meta.status === "finished") {
        out.push(meta);
        continue;
      }
      let file: SyncHandle;
      try {
        file = await dir.open(takeFileName(id, meta.format));
      } catch {
        continue;
      }
      let fixed: TakeMeta | null = null;
      try {
        const frames = await repairTakeFile(file, meta.format);
        if (frames > 0) {
          const { peak: _peak, ...rest } = meta;
          fixed = { ...rest, frames, status: "finished", recovered: true, updatedAt: opts.now() };
        }
      } catch {
        fixed = null; // no header or nothing readable
      } finally {
        await closeQuietly(file);
      }
      if (fixed) {
        await writeText(sidecar, JSON.stringify(fixed));
        out.push(fixed);
      } else {
        await closeQuietly(sidecar);
        await dir.remove(takeMetaName(id)).catch(() => undefined);
        await dir.remove(takeFileName(id, meta.format)).catch(() => undefined);
      }
    } finally {
      await closeQuietly(sidecar);
    }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}
