import { linkApiRoot, MixerStateSchema, type LinkView, type MixerState } from "@bandroom/shared";
import { create } from "zustand";

/**
 * Public-link mode (SPEC §3.5, §11.2). While the link view is open, every API and media URL goes
 * to `/api/v1/l/<token>/…`, where the server answers the same contracts filtered to the link.
 * The link view has its own query cache, so link data never mixes with the logged-in app's.
 */
interface LinkModeState {
  token: string | null;
  view: LinkView | null;
}

export const useLinkMode = create<LinkModeState>(() => ({ token: null, view: null }));

export function enterLinkMode(token: string): void {
  useLinkMode.setState((s) => (s.token === token ? s : { token, view: null }));
}

export function leaveLinkMode(): void {
  useLinkMode.setState({ token: null, view: null });
}

export function setLinkView(view: LinkView | null): void {
  useLinkMode.setState({ view });
}

export function isLinkMode(): boolean {
  return useLinkMode.getState().token !== null;
}

/** `""` normally, `/l/<token>` in link mode (inserted after the API prefix). */
export function linkPathPrefix(): string {
  const token = useLinkMode.getState().token;
  return token === null ? "" : linkApiRoot(token);
}

/** Visitors' personal mix stays in this browser (no account to store it on). */
const mixKey = (songId: string) => `bandroom.linkMix.${songId}`;

export function loadLocalMix(songId: string): MixerState | null {
  try {
    const raw = localStorage.getItem(mixKey(songId));
    if (!raw) return null;
    const parsed = MixerStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function saveLocalMix(songId: string, mix: MixerState): void {
  try {
    localStorage.setItem(mixKey(songId), JSON.stringify(mix));
  } catch {
    // storage full or blocked: the mix just is not remembered
  }
}

/** The name for anonymous comments, remembered per browser as a default for new sessions. */
const NAME_KEY = "bandroom.linkVisitorName";

export function rememberedVisitorName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

export function rememberVisitorName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // ignore
  }
}
