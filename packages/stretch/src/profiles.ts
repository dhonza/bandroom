// Stretch settings per track profile (SPEC §30.4). The profile comes from the track's effective
// instrument; the quality is a per-device setting (Economy = Signalsmith's cheaper preset).

export type StretchProfile = "tonal" | "voice" | "percussive" | "mix";
export type StretchQuality = "high" | "economy";

export interface StretchSettings {
  blockSamples: number;
  intervalSamples: number;
  splitComputation: boolean;
  /** Partials above this are not transposed (keeps cymbals, breath and noise natural). */
  tonalityHz: number;
  /** Formant compensation (vocals). */
  formant: boolean;
}

const SAMPLE_RATE = 48_000;
const TONALITY_HZ = 8_000;
const ms = (v: number) => Math.round((v / 1000) * SAMPLE_RATE);

// High: Signalsmith's default preset (120 / 30 ms); drums use a shorter block for sharper attacks.
// Economy: its cheaper preset (100 / 40 ms), drums 60 / 30 ms.
const BLOCKS: Record<StretchQuality, Record<StretchProfile, [number, number]>> = {
  high: { tonal: [120, 30], voice: [120, 30], mix: [120, 30], percussive: [60, 15] },
  economy: { tonal: [100, 40], voice: [100, 40], mix: [100, 40], percussive: [60, 30] },
};

export function stretchSettings(profile: StretchProfile, quality: StretchQuality): StretchSettings {
  const [block, interval] = BLOCKS[quality][profile];
  return {
    blockSamples: ms(block),
    intervalSamples: ms(interval),
    splitComputation: false,
    tonalityHz: TONALITY_HZ,
    formant: profile === "voice",
  };
}
