import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPlaybackAudioSession, setRecordingAudioSession, WakeLockController } from "./platform";

/** A wake lock API whose requests resolve when the test says so. */
class FakeWakeLock {
  requests: { resolve: () => void; reject: () => void }[] = [];
  active = 0;
  request() {
    return new Promise<WakeLockSentinel>((resolve, reject) => {
      this.requests.push({
        resolve: () => {
          this.active++;
          let released = false;
          const listeners: (() => void)[] = [];
          resolve({
            release: () => {
              if (!released) {
                released = true;
                this.active--;
                for (const l of listeners) l();
              }
              return Promise.resolve();
            },
            addEventListener: (_: string, l: () => void) => {
              listeners.push(l);
            },
          } as unknown as WakeLockSentinel);
        },
        reject: () => {
          reject(new Error("denied"));
        },
      });
    });
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

let lock: FakeWakeLock;
beforeEach(() => {
  lock = new FakeWakeLock();
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  vi.stubGlobal("navigator", { wakeLock: lock });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WakeLockController", () => {
  it("requests one lock when changes arrive while a request is pending", async () => {
    const c = new WakeLockController("songOpen");
    c.setSongOpen(true);
    c.setPlaying(true);
    c.setSongOpen(true);
    expect(lock.requests).toHaveLength(1);
    lock.requests[0]?.resolve();
    await flush();
    expect(lock.active).toBe(1);
    c.setSongOpen(false);
    await flush();
    expect(lock.active).toBe(0);
  });

  it("releases a lock granted after it was no longer wanted", async () => {
    const c = new WakeLockController("songOpen");
    c.setSongOpen(true);
    c.dispose(); // the page left while the request was pending
    lock.requests[0]?.resolve();
    await flush();
    expect(lock.active).toBe(0);
  });

  it("tries again after a denied request", async () => {
    const c = new WakeLockController("playing");
    c.setPlaying(true);
    lock.requests[0]?.reject();
    await flush();
    expect(lock.active).toBe(0);
    c.setPlaying(true);
    expect(lock.requests).toHaveLength(2);
    lock.requests[1]?.resolve();
    await flush();
    expect(lock.active).toBe(1);
    c.dispose();
    await flush();
    expect(lock.active).toBe(0);
  });

  it("holds the lock while recording is armed, whatever the mode", async () => {
    const c = new WakeLockController("off");
    c.setRecording(true);
    expect(lock.requests).toHaveLength(1);
    lock.requests[0]?.resolve();
    await flush();
    expect(lock.active).toBe(1);
    c.setRecording(false);
    await flush();
    expect(lock.active).toBe(0);
  });
});

describe("audio session", () => {
  it("records while armed and plays back after (SPEC §9)", () => {
    const audioSession = { type: "auto" };
    vi.stubGlobal("navigator", { audioSession });
    setPlaybackAudioSession();
    expect(audioSession.type).toBe("playback");
    setRecordingAudioSession(true);
    expect(audioSession.type).toBe("play-and-record");
    setPlaybackAudioSession(); // a tap on Play keeps it while armed
    expect(audioSession.type).toBe("play-and-record");
    setRecordingAudioSession(false);
    expect(audioSession.type).toBe("playback");
  });
});
