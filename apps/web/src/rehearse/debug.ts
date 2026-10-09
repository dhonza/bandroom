import type { Engine } from "@bandroom/audio-engine";
import type { RehearseState } from "./controller";
import { practiceOf } from "@bandroom/shared";
import { clickSettingsOf } from "./model";

// ——— test hook (SPEC §20: engine debug state for e2e) ————————————————————————————

/** The engine and Rehearse state read by the e2e tests. */
export function debugSnapshot(engine: Engine | null, s: RehearseState, hasTempo: boolean) {
  return {
    songId: s.songId,
    open: s.open,
    previewSongId: s.previewSongId,
    queue: s.queue
      ? {
          songIds: s.queue.entries.map((e) => e.songId),
          index: s.queue.index,
          kind: s.queue.source.kind,
        }
      : null,
    repeat: s.repeat,
    dormant: s.dormant,
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
    buffer: s.buffer,
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
    practice: practiceOf(s.mix),
    enginePractice: engine?.practiceSetting ?? null,
  };
}

/** Exposes `window.__bandroomRehearse.state()` for the e2e tests. */
export function exposeDebug(state: () => unknown): void {
  (window as Window & { __bandroomRehearse?: unknown }).__bandroomRehearse = { state };
}
