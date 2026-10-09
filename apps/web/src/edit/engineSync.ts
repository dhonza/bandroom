import { dbToGain, songEndFrame, type TrackVersion } from "@bandroom/shared";
import { useEffect, useMemo } from "react";
import { setSnap, useTimelineUi } from "../markers/store";
import { setEditPlayback } from "../rehearse/controller";
import type { LaneClip } from "../timeline/render";
import type { Pyramid } from "../timeline/peaks";
import { framesToSec } from "./model";
import { setEditOptions, useEdit, type EditStore } from "./store";

/**
 * Keeps the engine on the session's clips while the page's song is in edit mode (SPEC §24.5):
 * every change switches the changed tracks in place; leaving edit mode (or the page) goes back to
 * the listened versions.
 */
export function useEditPlaybackSync(songId: string): void {
  useEffect(() => {
    const push = (s: EditStore) => {
      if (s.songId !== songId || !s.state || !s.session) {
        setEditPlayback(null);
        return;
      }
      setEditPlayback({
        songId,
        sessionId: s.session.id,
        clips: Object.fromEntries(s.state.tracks.map((t) => [t.trackId, t.clips])),
        versions: s.versions,
        lengthFrames: Math.max(1, songEndFrame(s.state)),
      });
    };
    push(useEdit.getState());
    const unsub = useEdit.subscribe((s, prev) => {
      if (s.state !== prev.state || s.session?.id !== prev.session?.id || s.songId !== prev.songId)
        push(s);
    });
    return () => {
      unsub();
      setEditPlayback(null);
    };
  }, [songId]);
}

/**
 * The session's snap mode is the timeline's while editing (SPEC §24.6, persisted in the
 * session): entering applies it, `S` and the snap menus change it.
 */
export function useEditSnapSync(songId: string): void {
  const editing = useEdit((s) => s.songId === songId && s.session !== null);
  useEffect(() => {
    if (!editing) return;
    const own = useEdit.getState().options.snap;
    if (useTimelineUi.getState().snap !== own) setSnap(own);
    return useTimelineUi.subscribe((t, prev) => {
      if (t.snap !== prev.snap && useEdit.getState().options.snap !== t.snap)
        setEditOptions({ snap: t.snap });
    });
  }, [editing]);
}

/** The peaks hashes the clips need (their source versions), besides those already shown. */
export function useEditPeakHashes(songId: string): string[] {
  const versions = useEdit((s) => (s.songId === songId ? s.versions : null));
  return useMemo(
    () =>
      versions
        ? Object.values(versions)
            .map((v) => v.variants.peaks?.hash ?? null)
            .filter((h): h is string => h !== null)
        : [],
    [versions],
  );
}

/** A lane's clips for the timeline canvas (SPEC §24.6). */
export function laneClipsOf(
  clips: readonly {
    sourceVersionId: string;
    startFrame: number;
    lengthFrames: number;
    sourceStartFrame: number;
    gainDb: number;
    fadeInFrames: number;
    fadeOutFrames: number;
    fadeInShape: "linear" | "equalPower";
    fadeOutShape: "linear" | "equalPower";
  }[],
  versions: Readonly<Record<string, TrackVersion>>,
  peaksByHash: ReadonlyMap<string, Pyramid | null>,
): LaneClip[] {
  return clips.map((c) => {
    const hash = versions[c.sourceVersionId]?.variants.peaks?.hash ?? null;
    return {
      startSec: framesToSec(c.startFrame),
      endSec: framesToSec(c.startFrame + c.lengthFrames),
      sourceStartSec: framesToSec(c.sourceStartFrame),
      peaks: hash ? (peaksByHash.get(hash) ?? null) : null,
      scale: dbToGain(c.gainDb),
      fadeInSec: framesToSec(c.fadeInFrames),
      fadeOutSec: framesToSec(c.fadeOutFrames),
      fadeInShape: c.fadeInShape,
      fadeOutShape: c.fadeOutShape,
    };
  });
}
