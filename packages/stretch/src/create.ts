import type { StretchModule } from "./module";
import { stretchSettings, type StretchProfile, type StretchQuality } from "./profiles";
import { StretchStream } from "./stream";

export interface StretchSpec {
  channels: number;
  /** Timeline frames per output frame (0.5 = half speed). */
  rate: number;
  /** Pitch shift in semitones (cents included as a fraction); 0 for a track kept at pitch. */
  semitones: number;
  profile: StretchProfile;
  quality: StretchQuality;
  /** Rough fundamental for vocal formant compensation (0 = estimate). */
  voiceBaseHz: number;
  /** Largest input block the caller pushes at once (it is split internally anyway). */
  maxIn?: number;
}

const DEFAULT_MAX_IN = 16_384;

/** Creates a configured stream; dispose it with `stream.dispose()`. */
export function createStretch(
  mod: StretchModule,
  spec: StretchSpec,
): StretchStream & { dispose(): void } {
  const settings = stretchSettings(spec.profile, spec.quality);
  const maxIn = Math.max(spec.maxIn ?? DEFAULT_MAX_IN, DEFAULT_MAX_IN);
  const stretcher = mod.create({
    channels: spec.channels,
    blockSamples: settings.blockSamples,
    intervalSamples: settings.intervalSamples,
    splitComputation: settings.splitComputation,
    maxIn,
    maxOut: Math.ceil(maxIn / Math.min(1, spec.rate)) + 1,
  });
  stretcher.setTranspose(spec.semitones, settings.tonalityHz);
  stretcher.setFormant(settings.formant, spec.voiceBaseHz);
  const stream = new StretchStream(stretcher, spec.rate) as StretchStream & { dispose(): void };
  stream.dispose = () => {
    stretcher.dispose();
  };
  return stream;
}
