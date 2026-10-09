import type { EditBaseTrack, EditClip, FadeShape } from "./schema";

/** Clip helpers shared by the reducers (SPEC §24.2–§24.3). Clips are never mutated in place. */

export const clipEnd = (c: EditClip): number => c.startFrame + c.lengthFrames;

/** The clip a track starts with: its current version at `offsetSamples` with the version gain. */
export function initialClip(
  t: Pick<EditBaseTrack, "trackId" | "versionId" | "offsetSamples" | "gainDb" | "lengthFrames">,
): EditClip | null {
  const skip = Math.max(0, -t.offsetSamples);
  if (skip >= t.lengthFrames) return null;
  return {
    id: `${t.trackId}:base`,
    sourceVersionId: t.versionId,
    sourceStartFrame: skip,
    startFrame: Math.max(0, t.offsetSamples),
    lengthFrames: t.lengthFrames - skip,
    gainDb: Math.min(24, Math.max(-60, t.gainDb)),
    fadeInFrames: 0,
    fadeOutFrames: 0,
    fadeInShape: "equalPower",
    fadeOutShape: "equalPower",
  };
}

/** Deterministic ids for the clips an op creates: `<op id>:<n>`, so a replay yields the same. */
export function idMaker(opId: string): () => string {
  let n = 0;
  return () => `${opId}:${n++}`;
}

/** Source frames available after the clip's end (`lengths` per version, 48 kHz). */
export function sourceAfter(c: EditClip, lengths: Readonly<Record<string, number>>): number {
  const len = lengths[c.sourceVersionId] ?? c.sourceStartFrame + c.lengthFrames;
  return Math.max(0, len - c.sourceStartFrame - c.lengthFrames);
}

/** Frames the clip's start can move left: limited by the source start and the timeline start. */
export const sourceBefore = (c: EditClip): number => Math.min(c.sourceStartFrame, c.startFrame);

/** Pieces of the same source, aligned so that one continues the other. */
export function contiguous(a: EditClip, b: EditClip): boolean {
  return (
    a.sourceVersionId === b.sourceVersionId &&
    a.sourceStartFrame - a.startFrame === b.sourceStartFrame - b.startFrame
  );
}

/** `[start, at)` of the clip (keeps the fade-in), with `id`. */
export function headOf(c: EditClip, at: number, id: string): EditClip {
  return {
    ...c,
    id,
    lengthFrames: at - c.startFrame,
    fadeOutFrames: 0,
    fadeOutShape: "equalPower",
  };
}

/** `[at, end)` of the clip (keeps the fade-out), with `id`. */
export function tailOf(c: EditClip, at: number, id: string): EditClip {
  return {
    ...c,
    id,
    startFrame: at,
    sourceStartFrame: c.sourceStartFrame + (at - c.startFrame),
    lengthFrames: clipEnd(c) - at,
    fadeInFrames: 0,
    fadeInShape: "equalPower",
  };
}

/** Moves the clip's start left by `n` frames, revealing more of its source. */
export function extendStart(c: EditClip, n: number): EditClip {
  return {
    ...c,
    startFrame: c.startFrame - n,
    sourceStartFrame: c.sourceStartFrame - n,
    lengthFrames: c.lengthFrames + n,
  };
}

export const extendEnd = (c: EditClip, n: number): EditClip => ({
  ...c,
  lengthFrames: c.lengthFrames + n,
});

export const withFadeIn = (c: EditClip, frames: number, shape: FadeShape): EditClip => ({
  ...c,
  fadeInFrames: frames,
  fadeInShape: shape,
});

export const withFadeOut = (c: EditClip, frames: number, shape: FadeShape): EditClip => ({
  ...c,
  fadeOutFrames: frames,
  fadeOutShape: shape,
});

/** Fades never exceed half the clip (SPEC §24.3). */
export function clampFades(c: EditClip): EditClip {
  const half = Math.floor(c.lengthFrames / 2);
  if (c.fadeInFrames <= half && c.fadeOutFrames <= half) return c;
  return {
    ...c,
    fadeInFrames: Math.min(c.fadeInFrames, half),
    fadeOutFrames: Math.min(c.fadeOutFrames, half),
  };
}

/** Timeline order: start, then id (deterministic). */
export function sortClips(clips: EditClip[]): EditClip[] {
  return clips.sort((a, b) => a.startFrame - b.startFrame || (a.id < b.id ? -1 : 1));
}

/** The most clips playing at one frame. */
export function maxOverlap(clips: readonly EditClip[]): number {
  const points: [number, number][] = [];
  for (const c of clips) points.push([c.startFrame, 1], [clipEnd(c), -1]);
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let max = 0;
  for (const [, d] of points) {
    cur += d;
    max = Math.max(max, cur);
  }
  return max;
}

/**
 * The clips merged where a split left seamless pieces (same source, contiguous, same gain, no
 * fades between them), ids dropped: two clip lists that play the same compare equal.
 */
export function canonicalClips(clips: readonly EditClip[]): Omit<EditClip, "id">[] {
  const out: Omit<EditClip, "id">[] = [];
  for (const c of sortClips([...clips])) {
    const { id: _id, ...rest } = c;
    const prev = out.at(-1);
    if (
      prev &&
      prev.startFrame + prev.lengthFrames === c.startFrame &&
      contiguous({ ...prev, id: "" }, c) &&
      prev.gainDb === c.gainDb &&
      prev.fadeOutFrames === 0 &&
      c.fadeInFrames === 0
    ) {
      prev.lengthFrames += c.lengthFrames;
      prev.fadeOutFrames = c.fadeOutFrames;
      prev.fadeOutShape = c.fadeOutShape;
      continue;
    }
    out.push(rest);
  }
  return out;
}
