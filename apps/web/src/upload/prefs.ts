import { DEFAULT_AUDIO_QUALITY, UploadOptionsSchema, type UploadOptions } from "@bandroom/shared";
import { create } from "zustand";

/** This device's upload settings (SPEC §28.2), remembered for the next upload. */
const KEY = "bandroom.uploadOptions";

const DEFAULTS: UploadOptions = { lossyOnly: false, quality: DEFAULT_AUDIO_QUALITY };

function load(): UploadOptions {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = UploadOptionsSchema.safeParse(raw ? JSON.parse(raw) : {});
    return parsed.success ? parsed.data : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

interface UploadPrefsState {
  options: UploadOptions;
  set: (options: UploadOptions) => void;
}

/** Shared by every upload settings control, so they all show the same choice. */
export const useUploadPrefs = create<UploadPrefsState>((set) => ({
  options: load(),
  set: (options) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(options));
    } catch {
      // not remembered
    }
    set({ options });
  },
}));

/**
 * The options to send with an audio upload, or `undefined` for the defaults (keep full quality,
 * standard preset) so the target stays as before.
 */
export function uploadOptions(): UploadOptions | undefined {
  const o = useUploadPrefs.getState().options;
  return o.lossyOnly || o.quality !== DEFAULT_AUDIO_QUALITY ? o : undefined;
}
