import type { Engine } from "@bandroom/audio-engine";
import type { RehearseState } from "./controller";
import { clickSettingsOf } from "./model";

// ——— test hook (SPEC §20: engine debug state for e2e) ————————————————————————————

/** The engine and Rehearse state read by the e2e tests. */
export function debugSnapshot(engine: Engine | null, s: RehearseState, hasTempo: boolean) {
  return {
    status: s.status,
    position: engine ? engine.getPositionFrames() : 0,
    length: engine?.lengthFrames ?? 0,
    underruns: engine?.underrunCount ?? 0,
    context: engine?.contextState ?? "none",
    quality: s.quality,
    tracks: s.tracks.map((p) => ({
      id: p.track.id,
      version: p.version.id,
      kind: p.chosen.variant.kind,
    })),
    mix: s.mix,
    errors: s.errors,
    loop: engine?.loopRange ?? null,
    loopCached: engine?.loopCached ?? false,
    lap: engine?.lapInBase ?? 0,
    selectedTrackId: s.selectedTrackId,
    hasTempo,
    clickSettings: clickSettingsOf(s.mix),
    click: engine?.clickParams ?? null,
    clicks: engine?.clickCount ?? 0,
    countIn: engine?.getCountIn() ?? null,
    lastCountIn: engine?.lastCountInSpec ?? null,
    repeatCountIn: engine?.repeatCountInSpec ?? null,
  };
}

/** Exposes `window.__bandroomRehearse.state()` for the e2e tests. */
export function exposeDebug(state: () => unknown): void {
  (window as Window & { __bandroomRehearse?: unknown }).__bandroomRehearse = { state };
}
