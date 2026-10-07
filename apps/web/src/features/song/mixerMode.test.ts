import { afterEach, describe, expect, it, vi } from "vitest";
import { initialMixerOpen, loadMixerOpen, saveMixerOpen, type MixerFacts } from "./mixerMode";

const facts = (f: Partial<MixerFacts> = {}): MixerFacts => ({
  stored: true,
  trackCount: 2,
  mixPlayable: true,
  listenPlayingThisSong: false,
  ...f,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("initialMixerOpen", () => {
  it("follows the stored choice when the mix can play", () => {
    expect(initialMixerOpen(facts({ stored: true }))).toBe(true);
    expect(initialMixerOpen(facts({ stored: false }))).toBe(false);
  });

  it("stays closed without tracks", () => {
    expect(initialMixerOpen(facts({ trackCount: 0, mixPlayable: false }))).toBe(false);
  });

  it("stays closed while the mix plays this song", () => {
    expect(initialMixerOpen(facts({ listenPlayingThisSong: true }))).toBe(false);
  });

  it("follows the stored choice without a playable mix too (default mix, SPEC §25.5)", () => {
    expect(initialMixerOpen(facts({ stored: false, mixPlayable: false }))).toBe(false);
    expect(initialMixerOpen(facts({ stored: true, mixPlayable: false }))).toBe(true);
  });
});

describe("mixer choice storage", () => {
  it("round-trips through the former song-mode key", () => {
    expect(loadMixerOpen()).toBe(false);
    saveMixerOpen(true);
    expect(localStorage.getItem("bandroom.songMode")).toBe("rehearse");
    expect(loadMixerOpen()).toBe(true);
    saveMixerOpen(false);
    expect(localStorage.getItem("bandroom.songMode")).toBe("listen");
    expect(loadMixerOpen()).toBe(false);
  });

  it("keeps the old Rehearse choice", () => {
    localStorage.setItem("bandroom.songMode", "rehearse");
    expect(loadMixerOpen()).toBe(true);
  });

  it("survives a broken localStorage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(loadMixerOpen()).toBe(false);
    expect(() => {
      saveMixerOpen(true);
    }).not.toThrow();
  });
});
