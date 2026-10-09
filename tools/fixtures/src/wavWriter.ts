import fs from "node:fs/promises";

export type SampleFormat = "s16" | "s24" | "s32" | "f32";

export interface ExtraChunk {
  id: string;
  data: Buffer;
  /** Place before the data chunk (default) or after it. */
  after?: boolean;
}

export interface WavSpec {
  sampleRate: number;
  channels: number;
  format: SampleFormat;
  frames: number;
  /** Sample value in [-1, 1] for (frame, channel); f32 keeps values outside it (overs). */
  sample: (frame: number, channel: number) => number;
  extraChunks?: ExtraChunk[];
  /** Write WAVE_FORMAT_EXTENSIBLE instead of plain PCM/float. */
  extensible?: boolean;
}

const BYTES: Record<SampleFormat, number> = { s16: 2, s24: 3, s32: 4, f32: 4 };

function chunk(id: string, data: Buffer): Buffer {
  const h = Buffer.alloc(8);
  h.write(id, 0, "latin1");
  h.writeUInt32LE(data.length, 4);
  return Buffer.concat([h, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function fmtChunk(spec: WavSpec): Buffer {
  const bps = BYTES[spec.format];
  const isFloat = spec.format === "f32";
  const tag = spec.extensible ? 0xfffe : isFloat ? 3 : 1;
  const b = Buffer.alloc(spec.extensible ? 40 : 16);
  b.writeUInt16LE(tag, 0);
  b.writeUInt16LE(spec.channels, 2);
  b.writeUInt32LE(spec.sampleRate, 4);
  b.writeUInt32LE(spec.sampleRate * spec.channels * bps, 8);
  b.writeUInt16LE(spec.channels * bps, 12);
  b.writeUInt16LE(bps * 8, 14);
  if (spec.extensible) {
    b.writeUInt16LE(22, 16); // cbSize
    b.writeUInt16LE(bps * 8, 18); // valid bits
    b.writeUInt32LE(spec.channels === 1 ? 0x4 : 0x3, 20); // channel mask
    // SubFormat GUID: {0000000X-0000-0010-8000-00AA00389B71}
    b.writeUInt16LE(isFloat ? 3 : 1, 24);
    Buffer.from([
      0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
    ]).copy(b, 26);
  }
  return chunk("fmt ", b);
}

function encodeSample(buf: Buffer, off: number, v: number, format: SampleFormat): void {
  if (format === "f32") {
    buf.writeFloatLE(v, off);
    return;
  }
  const x = Math.max(-1, Math.min(1, v));
  switch (format) {
    case "s16":
      buf.writeInt16LE(Math.round(x * 32767), off);
      break;
    case "s24":
      buf.writeIntLE(Math.round(x * 8388607), off, 3);
      break;
    case "s32":
      buf.writeInt32LE(Math.round(x * 2147483647), off);
      break;
  }
}

/** Writes a WAV file deterministically, streaming the data in blocks. */
export async function writeWav(file: string, spec: WavSpec): Promise<void> {
  const bps = BYTES[spec.format];
  const dataSize = spec.frames * spec.channels * bps;
  const before = (spec.extraChunks ?? []).filter((c) => !c.after).map((c) => chunk(c.id, c.data));
  const after = (spec.extraChunks ?? []).filter((c) => c.after).map((c) => chunk(c.id, c.data));
  const fmt = fmtChunk(spec);
  const riffSize =
    4 +
    fmt.length +
    before.reduce((a, b) => a + b.length, 0) +
    8 +
    dataSize +
    (dataSize % 2) +
    after.reduce((a, b) => a + b.length, 0);

  const fh = await fs.open(file, "w");
  try {
    const head = Buffer.alloc(12);
    head.write("RIFF", 0, "ascii");
    head.writeUInt32LE(riffSize, 4);
    head.write("WAVE", 8, "ascii");
    await fh.write(head);
    await fh.write(fmt);
    for (const c of before) await fh.write(c);
    const dh = Buffer.alloc(8);
    dh.write("data", 0, "ascii");
    dh.writeUInt32LE(dataSize, 4);
    await fh.write(dh);
    const block = 8192;
    for (let f0 = 0; f0 < spec.frames; f0 += block) {
      const n = Math.min(block, spec.frames - f0);
      const buf = Buffer.alloc(n * spec.channels * bps);
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < spec.channels; c++) {
          encodeSample(buf, (i * spec.channels + c) * bps, spec.sample(f0 + i, c), spec.format);
        }
      }
      await fh.write(buf);
    }
    if (dataSize % 2) await fh.write(Buffer.alloc(1));
    for (const c of after) await fh.write(c);
  } finally {
    await fh.close();
  }
}
