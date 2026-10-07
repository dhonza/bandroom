/**
 * Platform specifics for Rehearse mode (SPEC §6.8): the iOS audio session and the screen wake
 * lock. Both are best-effort; unsupported browsers simply skip them.
 */

/** Plays through the ring/silent switch on iOS Safari (Audio Session API). */
export function setPlaybackAudioSession(): void {
  const nav = navigator as Navigator & { audioSession?: { type: string } };
  try {
    if (nav.audioSession) nav.audioSession.type = "playback";
  } catch {
    // not supported
  }
}

export type WakeLockMode = "off" | "playing" | "songOpen";

/** Keeps the screen on while playing (and 5 min after a pause) or while a song is open. */
export class WakeLockController {
  private sentinel: WakeLockSentinel | null = null;
  /** A request is in flight (one at a time; its result is checked against the state after). */
  private requesting = false;
  private playing = false;
  private open = false;
  private holdUntil = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly onVisible = () => {
    if (document.visibilityState === "visible") void this.apply();
  };

  constructor(
    private mode: WakeLockMode,
    private readonly holdMs = 5 * 60_000,
  ) {
    document.addEventListener("visibilitychange", this.onVisible);
  }

  setMode(mode: WakeLockMode): void {
    this.mode = mode;
    void this.apply();
  }

  setPlaying(playing: boolean): void {
    if (this.playing && !playing) this.holdUntil = Date.now() + this.holdMs;
    this.playing = playing;
    void this.apply();
  }

  setSongOpen(open: boolean): void {
    this.open = open;
    void this.apply();
  }

  dispose(): void {
    document.removeEventListener("visibilitychange", this.onVisible);
    this.open = false;
    this.playing = false;
    this.holdUntil = 0;
    void this.apply();
  }

  private wanted(): boolean {
    if (this.mode === "off") return false;
    if (this.mode === "songOpen") return this.open;
    return this.playing || Date.now() < this.holdUntil;
  }

  private async apply() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const want = this.wanted();
    if (want && !this.playing && this.mode === "playing") {
      this.timer = setTimeout(
        () => void this.apply(),
        Math.max(0, this.holdUntil - Date.now()) + 50,
      );
    }
    if (
      want &&
      !this.sentinel &&
      !this.requesting &&
      document.visibilityState === "visible" &&
      "wakeLock" in navigator
    ) {
      this.requesting = true;
      let s: WakeLockSentinel;
      try {
        s = await navigator.wakeLock.request("screen");
      } catch {
        // denied (battery saver, not visible): try again on the next change
        return;
      } finally {
        this.requesting = false;
      }
      if (!this.wanted()) {
        // No longer wanted (paused, closed, disposed) while the request was pending.
        await s.release().catch(() => undefined);
        return;
      }
      this.sentinel = s;
      s.addEventListener("release", () => {
        if (this.sentinel === s) this.sentinel = null;
      });
    } else if (!want && this.sentinel) {
      const s = this.sentinel;
      this.sentinel = null;
      await s.release().catch(() => undefined);
    }
  }
}
