import { OPUS_PREROLL_FRAMES } from "../constants";

/** Seek index entries `[sample, byte offset]` as stored by the ingest (decision log, M3). */
export type SeekIndex = readonly (readonly [number, number])[];

/** Last entry whose sample is ≤ `sample` (0 when none). */
export function entryAtOrBefore(index: SeekIndex, sample: number): number {
  let lo = 0;
  let hi = index.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((index[mid]?.[0] ?? 0) <= sample) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

export interface OpusSeekPoint {
  byteOffset: number;
  /**
   * Decoder sample index (pre-skip included) of the first packet that starts on the page, or
   * null to derive it from the page's granule (always correct unless the page is the last one).
   */
  startDecoded: number | null;
}

/**
 * Where to start reading an Opus stream to play from timeline frame `target`: at least 80 ms of
 * pre-roll (RFC 7845 §4.6) plus one maximum packet, since a page may begin with the tail of a
 * packet that has to be skipped.
 */
export function opusSeekPoint(index: SeekIndex, preSkip: number, target: number): OpusSeekPoint {
  if (index.length === 0) return { byteOffset: 0, startDecoded: 0 };
  const i = entryAtOrBefore(index, target - OPUS_PREROLL_FRAMES - 5760);
  const [sample, byteOffset] = index[i] ?? [0, 0];
  // The first entry is the first audio page, whose first packet is decoder sample 0 (its stored
  // sample is clamped at 0, so it cannot carry the −preSkip start).
  return { byteOffset, startDecoded: i === 0 ? 0 : sample + preSkip };
}

export interface FlacSeekPoint {
  byteOffset: number;
  /** Source frame at which decoding restarts (a frame start). */
  frame: number;
}

export function flacSeekPoint(index: SeekIndex, sourceFrame: number): FlacSeekPoint {
  if (index.length === 0) return { byteOffset: 0, frame: 0 };
  const [frame, byteOffset] = index[entryAtOrBefore(index, sourceFrame)] ?? [0, 0];
  return { byteOffset, frame };
}
