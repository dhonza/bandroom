import {
  remapComments,
  remapMarkers,
  remapSteps,
  remapTempoMap,
  type Comment,
  type Marker,
  type RemapStep,
  type SongTempo,
} from "@bandroom/shared";
import { useEffect, useMemo } from "react";
import { endTempoPreview, previewTempo } from "../tempo/store";
import { useEdit } from "./store";

/**
 * The remap preview of edit mode (SPEC §24.4, §24.6): markers, sections, comments and the tempo
 * map are drawn where the edit moves them. Nothing is written; the server writes the remap when
 * the edit is applied (M18).
 */

const NO_STEPS: RemapStep[] = [];

/** The timeline steps of the edit on `songId` (empty when not editing it). */
export function useRemapSteps(songId: string): RemapStep[] {
  const base = useEdit((s) => (s.songId === songId ? s.base : null));
  const ops = useEdit((s) => s.ops);
  const cursor = useEdit((s) => s.cursor);
  return useMemo(() => (base ? remapSteps(base, ops, cursor) : NO_STEPS), [base, ops, cursor]);
}

export function useRemappedMarkers(
  songId: string,
  markers: Marker[],
  tempo: SongTempo | null,
): Marker[] {
  const steps = useRemapSteps(songId);
  return useMemo(
    () => (steps.length === 0 ? markers : remapMarkers(markers, steps, tempo).items),
    [steps, markers, tempo],
  );
}

export function useRemappedComments(songId: string, comments: Comment[]): Comment[] {
  const steps = useRemapSteps(songId);
  const sessionId = useEdit((s) => s.session?.id ?? "");
  return useMemo(
    () => (steps.length === 0 ? comments : remapComments(comments, steps, sessionId).items),
    [steps, comments, sessionId],
  );
}

/** Shows the remapped tempo map on the timeline while editing (the tempo store's preview). */
export function useTempoRemapPreview(songId: string, tempo: SongTempo | null): void {
  const steps = useRemapSteps(songId);
  useEffect(() => {
    if (steps.length === 0 || !tempo) return;
    const mapped = remapTempoMap(tempo, steps);
    previewTempo(songId, mapped ? { ...tempo, ...mapped } : null);
    return () => {
      endTempoPreview();
    };
  }, [songId, steps, tempo]);
}
