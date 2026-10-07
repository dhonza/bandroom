/**
 * Equal-power pan law (SPEC §6.6), shared by the server mixdown and the browser engine (M5) so
 * both produce the same balance.
 *
 * - Mono sources: θ = (pan + 1)·π/4, L = cos θ, R = sin θ (−3 dB each at center).
 * - Stereo sources (balance): both channels at unity at center; turning away attenuates the
 *   opposite channel with the same equal-power curve, never boosting above unity.
 */
export function panGains(pan: number, source: "mono" | "stereo"): { left: number; right: number } {
  return panGainsInto(pan, source, { left: 0, right: 0 });
}

/** `panGains` writing into `out` (allocation-free, for the audio render loop); returns `out`. */
export function panGainsInto<T extends { left: number; right: number }>(
  pan: number,
  source: "mono" | "stereo",
  out: T,
): T {
  const p = Math.max(-1, Math.min(1, pan));
  const theta = ((p + 1) * Math.PI) / 4;
  if (source === "mono") {
    out.left = Math.cos(theta);
    out.right = Math.sin(theta);
  } else {
    out.left = Math.min(1, Math.SQRT2 * Math.cos(theta));
    out.right = Math.min(1, Math.SQRT2 * Math.sin(theta));
  }
  return out;
}

/** dB → linear gain; the fader bottom (≤ −120 dB or −Infinity) is silence. */
export function dbToGain(db: number): number {
  return db <= -120 ? 0 : 10 ** (db / 20);
}
