import { isLossyVersion, type TrackVersion } from "@bandroom/shared";
import type { TFunction } from "i18next";

/** "128 kbps stereo" / "64 kbps mono" (the wording of the remove-full-quality dialog). */
export function opusRate(t: TFunction, kbps: number, channels: number): string {
  return t(channels === 1 ? "lossless.now.rateMono" : "lossless.now.rateStereo", { kbps });
}

const REASON_KEY = {
  removed: "tracks.quality.reason.removed",
  upload: "tracks.quality.reason.upload",
  reencode: "tracks.quality.reason.reencode",
} as const;

/**
 * What is stored of a version, in one line (built only from the version DTO):
 * "FLAC 24-bit 48 kHz + Opus 64 kbps mono" for full quality, "Opus 128 kbps stereo (converted on
 * upload)" for lossy ones. The FLAC details come from the FLAC variant, or from the source's media
 * facts when the viewer may not download it (the variant is then hidden). `null` before processing.
 */
export function storedQuality(
  v: Pick<TrackVersion, "media" | "variants" | "archived">,
  t: TFunction,
): string | null {
  const { opus, flac } = v.variants;
  const opusText = opus
    ? t("tracks.quality.opus", { rate: opusRate(t, opus.bitrate, opus.channels) })
    : null;
  if (isLossyVersion(v)) {
    if (!opusText) return null;
    const reason = t(v.archived ? REASON_KEY[v.archived.reason] : "tracks.quality.reason.source");
    return t("tracks.quality.lossy", { opus: opusText, reason });
  }
  let flacText: string | null = null;
  const facts = flac ?? (v.media?.lossless ? v.media : null);
  if (facts) {
    const khz = Math.round(facts.sampleRate / 100) / 10;
    const nearLossless = flac?.nearLossless === true;
    flacText = facts.bitDepth
      ? t(nearLossless ? "tracks.quality.flacFromFloat" : "tracks.quality.flac", {
          bits: facts.bitDepth,
          khz,
        })
      : t("tracks.quality.flacNoBits", { khz });
  }
  if (flacText && opusText) return t("tracks.quality.both", { flac: flacText, opus: opusText });
  return flacText ?? opusText;
}
