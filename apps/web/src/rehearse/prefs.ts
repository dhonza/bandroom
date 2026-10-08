import type { StretchQuality, WakeLockMode } from "@bandroom/audio-engine";
import type { QualityPref } from "./model";

/** Per-device Rehearse settings (SPEC §6.8, §6.9: stored locally). */
export interface RehearsePrefs {
  quality: QualityPref;
  preferLossless: boolean;
  wakeLock: WakeLockMode;
  /** Practice speed/pitch processing (SPEC §30.2): auto = economy on phones. */
  practiceQuality: PracticeQualityPref;
}

export type PracticeQualityPref = "auto" | "high" | "economy";

const KEY = "bandroom.rehearsePrefs";

const DEFAULTS: RehearsePrefs = {
  quality: "auto",
  preferLossless: false,
  wakeLock: "playing",
  practiceQuality: "auto",
};

export function loadPrefs(): RehearsePrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const p = JSON.parse(raw) as Partial<RehearsePrefs>;
    return {
      quality: ["auto", "lossless", "high", "low"].includes(p.quality ?? "")
        ? (p.quality ?? "auto")
        : "auto",
      preferLossless: p.preferLossless === true,
      wakeLock: ["off", "playing", "songOpen"].includes(p.wakeLock ?? "")
        ? (p.wakeLock ?? "playing")
        : "playing",
      practiceQuality: ["auto", "high", "economy"].includes(p.practiceQuality ?? "")
        ? (p.practiceQuality ?? "auto")
        : "auto",
    };
  } catch {
    return DEFAULTS;
  }
}

export function savePrefs(p: RehearsePrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // per-device convenience only
  }
}

/** Phones get the smaller compressed-audio cache (SPEC §6.4). */
export function isPhoneDevice(): boolean {
  const ua = navigator.userAgent;
  return (
    /iPhone|iPad|iPod|Android/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  );
}

/** The stretch quality to use on this device. */
export function practiceQuality(pref: PracticeQualityPref): StretchQuality {
  if (pref === "auto") return isPhoneDevice() ? "economy" : "high";
  return pref;
}

export function cacheBytes(): number {
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return isPhoneDevice() || (mem !== undefined && mem <= 4) ? 256 * 2 ** 20 : 1024 * 2 ** 20;
}

export function connectionInfo(): {
  saveData: boolean;
  slow: boolean;
  downlinkMbps: number | null;
} {
  const c = (
    navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string; downlink?: number };
    }
  ).connection;
  return {
    saveData: c?.saveData === true,
    slow: ["slow-2g", "2g"].includes(c?.effectiveType ?? ""),
    downlinkMbps: typeof c?.downlink === "number" && c.downlink > 0 ? c.downlink : null,
  };
}
