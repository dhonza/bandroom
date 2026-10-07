import fs from "node:fs/promises";

/**
 * Ogg/Opus helpers (SPEC §5.3 steps 5 and 7). Reads page headers incrementally; the audio data
 * itself is skipped.
 */

export interface OggInfo {
  preSkip: number;
  /** Final granule position minus pre-skip = decodable samples at 48 kHz. */
  totalSamples: number;
  /** [sample position (after pre-skip) where the page's first new sample starts, byte offset]. */
  seekIndex: [number, number][];
}

export async function readOggOpus(file: string, minSpacingSamples = 48_000): Promise<OggInfo> {
  const fh = await fs.open(file, "r");
  try {
    const { size } = await fh.stat();
    let preSkip = -1;
    let lastGranule = 0;
    let prevEnd = 0; // granule at the end of the previous audio page
    const index: [number, number][] = [];
    let lastIndexed = -Infinity;
    let pos = 0;
    const header = Buffer.alloc(27 + 255);
    while (pos + 27 <= size) {
      const { bytesRead } = await fh.read(header, 0, Math.min(header.length, size - pos), pos);
      if (bytesRead < 27 || header.toString("ascii", 0, 4) !== "OggS")
        throw new Error(`Bad Ogg page at ${pos}`);
      const granule = Number(header.readBigInt64LE(6));
      const nSeg = header.readUInt8(26);
      let bodyLen = 0;
      for (let i = 0; i < nSeg; i++) bodyLen += header.readUInt8(27 + i);
      const bodyStart = pos + 27 + nSeg;

      if (preSkip < 0) {
        const head = Buffer.alloc(Math.min(19, bodyLen));
        await fh.read(head, 0, head.length, bodyStart);
        if (head.toString("ascii", 0, 8) !== "OpusHead") throw new Error("Not an Ogg Opus stream");
        preSkip = head.readUInt16LE(10);
      } else if (granule > 0) {
        const startSample = Math.max(0, prevEnd - preSkip);
        if (startSample - lastIndexed >= minSpacingSamples || index.length === 0) {
          index.push([startSample, pos]);
          lastIndexed = startSample;
        }
        prevEnd = granule;
        lastGranule = granule;
      }
      pos = bodyStart + bodyLen;
    }
    if (preSkip < 0) throw new Error("Empty Ogg file");
    return { preSkip, totalSamples: Math.max(0, lastGranule - preSkip), seekIndex: index };
  } finally {
    await fh.close();
  }
}
