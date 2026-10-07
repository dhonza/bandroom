import { useMediaQuery } from "@mantine/hooks";
import { create } from "zustand";
import type { PageTurn } from "../markers/keymap";
import { DESKTOP_QUERY } from "../shell/mediaQueries";

const WIDTH_KEY = "bandroom.docsPanelWidth";
export const DOCS_PANEL_MIN = 320;
export const DOCS_PANEL_DEFAULT = 480;

function loadWidth(): number {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(v) && v >= DOCS_PANEL_MIN ? v : DOCS_PANEL_DEFAULT;
  } catch {
    return DOCS_PANEL_DEFAULT;
  }
}

export interface DocsUiState {
  /** The song whose documents the panel shows (the panel belongs to the song page). */
  songId: string | null;
  open: boolean;
  /** The document shown in the panel; null = the list. */
  documentId: string | null;
  /** Desktop panel width in px (resizable, remembered per device). */
  width: number;
}

/** Split view next to the player (SPEC §10, §11.3): desktop side panel, phone sheet. */
export const useDocsUi = create<DocsUiState>(() => ({
  songId: null,
  open: false,
  documentId: null,
  width: loadWidth(),
}));

/** A new song page starts with the panel closed. */
export function docsPanelFor(songId: string | null): void {
  if (useDocsUi.getState().songId === songId) return;
  useDocsUi.setState({ songId, open: false, documentId: null });
}

/** The documents panel is open as a sheet (below the desktop breakpoint, 64em). */
export function useDocsSheetOpen(): boolean {
  const open = useDocsUi((s) => s.open);
  const desktop = useMediaQuery(DESKTOP_QUERY, false, { getInitialValueInEffect: false });
  return open && !desktop;
}

export function openDocsPanel(documentId: string | null = null): void {
  useDocsUi.setState({ open: true, documentId });
}

export function closeDocsPanel(): void {
  useDocsUi.setState({ open: false });
}

export function showDocument(documentId: string | null): void {
  useDocsUi.setState({ documentId });
}

export function setDocsPanelWidth(width: number): void {
  const w = Math.round(Math.max(DOCS_PANEL_MIN, width));
  useDocsUi.setState({ width: w });
  try {
    localStorage.setItem(WIDTH_KEY, String(w));
  } catch {
    // private mode: width lasts for this page only
  }
}

// --- Page turning (SPEC §11.4) ----------------------------------------------------------------

type Pager = (turn: PageTurn) => void;
let pager: Pager | null = null;

/** The open document viewer registers how it turns pages (PDF page, or a screenful of text). */
export function registerPager(p: Pager): () => void {
  pager = p;
  return () => {
    if (pager === p) pager = null;
  };
}

/** Turns a page in the open viewer (pedal mapping on the song page); false when none is open. */
export function turnPage(turn: PageTurn): boolean {
  if (!pager) return false;
  pager(turn);
  return true;
}
