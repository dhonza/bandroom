/**
 * Listen mode (one `<audio>`) and Rehearse mode (the multitrack engine) never play at once:
 * whoever starts claims the audio and the other pauses.
 */
export type AudioOwner = "listen" | "rehearse";

const stoppers = new Map<AudioOwner, () => void>();

export function registerAudioOwner(owner: AudioOwner, stop: () => void): void {
  stoppers.set(owner, stop);
}

export function claimAudio(owner: AudioOwner): void {
  for (const [o, stop] of stoppers) if (o !== owner) stop();
}
