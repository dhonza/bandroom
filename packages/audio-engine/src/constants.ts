/** Engine-internal time is in frames at 48 kHz (SPEC §6.2). */
export const SAMPLE_RATE = 48_000;
/** AudioWorklet render quantum (Web Audio). */
export const RENDER_QUANTUM = 128;
/** PCM chunk size sent from the decoder worker to the mixer (SPEC §6.2). */
export const CHUNK_FRAMES = 4096;
/** Opus seeks decode at least this far before the target and discard it (RFC 7845 §4.6). */
export const OPUS_PREROLL_FRAMES = 3840;
