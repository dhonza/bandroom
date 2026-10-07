import { compileTempo, type SongTempo, type TempoGrid } from "@bandroom/shared";
import { create } from "zustand";

/**
 * The open song's tempo map (SPEC §7.1) for non-React code: grid lines, musical snapping and
 * nudges, bar.beat readouts, the click track and the count-in. A draft can be previewed live
 * while the tempo dialog is open.
 */
export interface TempoUiState {
  songId: string | null;
  tempo: SongTempo | null;
  grid: TempoGrid | null;
  /** The grid shows an unsaved draft (tempo dialog). */
  preview: boolean;
}

export const useTempoUi = create<TempoUiState>(() => ({
  songId: null,
  tempo: null,
  grid: null,
  preview: false,
}));

const gridOf = (t: SongTempo | null) =>
  t ? compileTempo({ map: t.map, bar1OffsetSec: t.bar1OffsetSec }) : null;

let saved: { songId: string; tempo: SongTempo | null } | null = null;

/** The server's tempo map for a song (keeps a running preview on top of it). */
export function setSongTempo(songId: string, tempo: SongTempo | null): void {
  saved = { songId, tempo };
  const s = useTempoUi.getState();
  if (s.preview && s.songId === songId) return;
  if (s.songId === songId && s.tempo === tempo) return;
  useTempoUi.setState({ songId, tempo, grid: gridOf(tempo), preview: false });
}

/** Shows an unsaved tempo map (null: none) until {@link endTempoPreview}. */
export function previewTempo(songId: string, tempo: SongTempo | null): void {
  useTempoUi.setState({ songId, tempo, grid: gridOf(tempo), preview: true });
}

export function endTempoPreview(): void {
  const s = useTempoUi.getState();
  if (!s.preview) return;
  const t = saved && saved.songId === s.songId ? saved.tempo : null;
  useTempoUi.setState({ tempo: t, grid: gridOf(t), preview: false });
}

export function currentGrid(): TempoGrid | null {
  return useTempoUi.getState().grid;
}

export function resetTempoUiForTests(): void {
  saved = null;
  useTempoUi.setState({ songId: null, tempo: null, grid: null, preview: false });
}
