/** File-name helpers for uploads, shared by the web folder drop and brctl (SPEC §5.1, §28.1). */

/** File extensions treated as audio when there is no MIME type (zip entries, local files). */
export const AUDIO_EXT = /\.(wav|wave|aif|aiff|flac|mp3|m4a|aac|ogg|oga|opus|wv|alac)$/i;

/** Whether a file name looks like audio (zip entries and local files carry no MIME type). */
export function isAudioName(name: string): boolean {
  return AUDIO_EXT.test(name);
}

/**
 * Track names for a batch of dropped files (SPEC §5.1): extension and the common prefix removed,
 * e.g. `MySong_Bass.wav`, `MySong_Drums.wav` → "Bass", "Drums".
 */
export function trackNamesFromFiles(names: readonly string[]): string[] {
  const bases = names.map((n) => n.replace(/\.[^.]+$/, ""));
  if (bases.length < 2) return bases.map((b) => b.trim() || "Track");
  let prefix = bases[0] ?? "";
  for (const b of bases) {
    while (!b.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  // Only cut at a separator so "Bass" and "Bassoon" do not become "" and "oon".
  const cut = Math.max(
    prefix.lastIndexOf("_"),
    prefix.lastIndexOf("-"),
    prefix.lastIndexOf(" "),
    prefix.lastIndexOf("."),
  );
  const strip = cut >= 0 ? cut + 1 : 0;
  return bases.map(
    (b) =>
      b
        .slice(strip)
        .replace(/^[\s_\-.]+/, "")
        .trim() ||
      b.trim() ||
      "Track",
  );
}
