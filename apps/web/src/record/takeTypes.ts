import type { TakeEndReason } from "@bandroom/audio-engine";

/**
 * A recorded take on this device (SPEC §9): the FLAC file `takes/<userId>/<takeId>.flac` in OPFS
 * and this JSON sidecar next to it (`<takeId>.json`), which the take writer rewrites every few
 * seconds while recording, so a crash or reload keeps the take and its placement.
 */
export interface TakeMeta {
  v: 1;
  takeId: string;
  userId: string;
  /** Recorded on a song page (new track or version) or the project page (a new song). */
  mode: "song" | "project";
  songId: string | null;
  projectId: string;
  /** Timeline frame (48 kHz) of the first captured frame. */
  startFrame: number;
  /** The latency estimate the take is placed with (frames). */
  latencyFrames: number;
  /**
   * Frames dropped from the head of the take while encoding: the latency reaches back before the
   * song start (a take started at 0), so the file starts at timeline frame 0 (SPEC §9).
   */
  trimmedFrames: number;
  channels: number;
  /** Frames in the file. */
  frames: number;
  status: "recording" | "finished";
  endedBy: TakeEndReason | null;
  gapFrames: number;
  createdAt: number;
  updatedAt: number;
  /** Left from an earlier session (finished by the recovery, or never saved): "Recover". */
  recovered?: boolean;
}

/** What the take writer needs to know about the next take (sent when Record is pressed). */
export interface TakeContext {
  userId: string;
  mode: TakeMeta["mode"];
  songId: string | null;
  projectId: string;
  latencyFrames: number;
}

/** Main thread → take writer worker. */
export type WriterRequest =
  /** The take port of a new arming (the other end went to the mixer worklet). */
  | { type: "port"; port: MessagePort }
  /** The next take's context (Record pressed). */
  | { type: "prepare"; ctx: TakeContext }
  /** The audio context went away before the worklet confirmed the end: finish what arrived. */
  | { type: "finalize"; endedBy: TakeEndReason }
  /** Finish takes left unfinished by a crash and list every take on the device. */
  | { type: "recover"; userId: string; requestId: number };

/** Take writer worker → main thread. */
export type WriterEvent =
  | { type: "started"; takeId: string }
  | { type: "finished"; meta: TakeMeta }
  /** The take never began or held no audio after the head trim: nothing was kept. */
  | { type: "empty" }
  /** Writing failed (storage full, OPFS unavailable): what was written is kept if it can be. */
  | { type: "failed"; error: string; meta: TakeMeta | null }
  | { type: "recovered"; requestId: number; takes: TakeMeta[] };

export const takeFileName = (takeId: string) => `${takeId}.flac`;
export const takeMetaName = (takeId: string) => `${takeId}.json`;

/** Parses a sidecar; null when it is not one of ours. */
export function parseTakeMeta(text: string): TakeMeta | null {
  try {
    const m = JSON.parse(text) as Partial<TakeMeta> | null;
    if (
      !m ||
      m.v !== 1 ||
      typeof m.takeId !== "string" ||
      typeof m.userId !== "string" ||
      typeof m.projectId !== "string" ||
      typeof m.startFrame !== "number" ||
      typeof m.frames !== "number" ||
      typeof m.channels !== "number"
    )
      return null;
    return m as TakeMeta;
  } catch {
    return null;
  }
}
