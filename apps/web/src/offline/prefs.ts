import type { OfflineQuality } from "@bandroom/shared";

/** This device's choice of offline quality, remembered for the next download (SPEC §13). */
const DEVICE_QUALITY_KEY = "bandroom.offlineQuality";
const DEVICE_LOSSLESS_KEY = "bandroom.offlineLossless";

export function deviceOfflinePrefs(): { quality: OfflineQuality; lossless: boolean } {
  try {
    return {
      quality: localStorage.getItem(DEVICE_QUALITY_KEY) === "small" ? "small" : "normal",
      lossless: localStorage.getItem(DEVICE_LOSSLESS_KEY) === "true",
    };
  } catch {
    return { quality: "normal", lossless: false };
  }
}

export function setDeviceOfflinePrefs(p: { quality: OfflineQuality; lossless: boolean }): void {
  try {
    localStorage.setItem(DEVICE_QUALITY_KEY, p.quality);
    localStorage.setItem(DEVICE_LOSSLESS_KEY, String(p.lossless));
  } catch {
    // not remembered
  }
}
