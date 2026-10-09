import { clampInputGain } from "./model";

/**
 * Per-device recording settings (SPEC §9, stored locally): the input gain per input device and
 * whether takes are 32-bit float. A per-device convenience only: storage errors are ignored.
 */
interface RecordPrefs {
  /** Input gain in dB by input device id ("default" when the browser gives none). */
  gains: Record<string, number>;
  float: boolean;
}

const KEY = "bandroom.recordPrefs";
/** Remembered devices at most (the oldest go first). */
const MAX_DEVICES = 20;

function load(): RecordPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { gains: {}, float: false };
    const p = JSON.parse(raw) as Partial<RecordPrefs> | null;
    const gains: Record<string, number> = {};
    if (p?.gains && typeof p.gains === "object") {
      for (const [k, v] of Object.entries(p.gains)) {
        if (typeof v === "number" && Number.isFinite(v)) gains[k] = clampInputGain(v);
      }
    }
    return { gains, float: p?.float === true };
  } catch {
    return { gains: {}, float: false };
  }
}

function save(p: RecordPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // per-device convenience only
  }
}

const deviceKey = (deviceId: string | null | undefined) => deviceId || "default";

/** The remembered input gain of a device (0 dB when none). */
export function loadInputGain(deviceId: string | null | undefined): number {
  return load().gains[deviceKey(deviceId)] ?? 0;
}

export function saveInputGain(deviceId: string | null | undefined, db: number): void {
  const p = load();
  const key = deviceKey(deviceId);
  // The device last set goes last; the oldest beyond the cap are dropped.
  const entries = Object.entries(p.gains).filter(([k]) => k !== key);
  entries.push([key, clampInputGain(db)]);
  save({ ...p, gains: Object.fromEntries(entries.slice(-MAX_DEVICES)) });
}

/** Takes are recorded as 32-bit float WAV (off: 24-bit FLAC). */
export function loadFloatTakes(): boolean {
  return load().float;
}

export function saveFloatTakes(on: boolean): void {
  save({ ...load(), float: on });
}
