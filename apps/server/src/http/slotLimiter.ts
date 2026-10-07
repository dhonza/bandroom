/**
 * A non-queuing limit on concurrent heavy work in the API process, e.g. ffmpeg for WAV downloads
 * (SPEC §19.6: one ffmpeg process at a time, 1 GB RAM). Callers that get no slot answer
 * `RATE_LIMITED` instead of waiting, so nothing piles up in memory.
 */
export class SlotLimiter {
  private used = 0;

  constructor(readonly slots = 1) {}

  /** Slots currently taken. */
  get inUse(): number {
    return this.used;
  }

  /**
   * Takes a slot. Returns its release function, or null when all slots are taken. Releasing is
   * idempotent, so every exit path (finish, client abort, tool error) may call it.
   */
  tryAcquire(): (() => void) | null {
    if (this.used >= this.slots) return null;
    this.used++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used--;
    };
  }
}
