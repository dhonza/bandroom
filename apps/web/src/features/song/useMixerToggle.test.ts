import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadMixerOpen, MIXER_OPEN_CAP, saveMixerOpen, useMixerToggle } from "./useMixerToggle";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

const stored = () => JSON.parse(localStorage.getItem("bandroom.mixerOpen") ?? "null") as unknown;

describe("mixer open storage", () => {
  it("stores open songs newest first and drops closed ones", () => {
    saveMixerOpen("a", true);
    saveMixerOpen("b", true);
    expect(stored()).toEqual(["b", "a"]);
    saveMixerOpen("a", true);
    expect(stored()).toEqual(["a", "b"]);
    saveMixerOpen("b", false);
    expect(stored()).toEqual(["a"]);
    expect(loadMixerOpen("a")).toBe(true);
    expect(loadMixerOpen("b")).toBe(false);
    expect(loadMixerOpen("c")).toBe(false);
  });

  it("caps the list, forgetting the oldest songs", () => {
    for (let i = 0; i < MIXER_OPEN_CAP + 5; i++) saveMixerOpen(`s${i}`, true);
    const ids = stored() as string[];
    expect(ids).toHaveLength(MIXER_OPEN_CAP);
    expect(ids[0]).toBe(`s${MIXER_OPEN_CAP + 4}`);
    expect(loadMixerOpen("s0")).toBe(false);
    expect(loadMixerOpen("s5")).toBe(true);
  });

  it("tolerates corrupt data and replaces it on the next write", () => {
    localStorage.setItem("bandroom.mixerOpen", "{not json");
    expect(loadMixerOpen("a")).toBe(false);
    localStorage.setItem("bandroom.mixerOpen", JSON.stringify({ a: true }));
    expect(loadMixerOpen("a")).toBe(false);
    localStorage.setItem("bandroom.mixerOpen", JSON.stringify(["a", 3, null]));
    expect(loadMixerOpen("a")).toBe(true);
    saveMixerOpen("b", true);
    expect(stored()).toEqual(["b", "a"]);
  });

  it("ignores the former device-wide choice and removes it on the first write", () => {
    localStorage.setItem("bandroom.songMode", "rehearse");
    expect(loadMixerOpen("a")).toBe(false);
    saveMixerOpen("a", false);
    expect(localStorage.getItem("bandroom.songMode")).toBeNull();
  });
});

describe("useMixerToggle", () => {
  it("starts from this song's choice and remembers each toggle", () => {
    saveMixerOpen("a", true);
    const { result } = renderHook(() => useMixerToggle(true, "a"));
    expect(result.current.open).toBe(true);
    act(() => {
      result.current.toggle();
    });
    expect(result.current.open).toBe(false);
    expect(loadMixerOpen("a")).toBe(false);
    act(() => {
      result.current.toggle();
    });
    expect(result.current.open).toBe(true);
    expect(loadMixerOpen("a")).toBe(true);
  });

  it("follows the song when the page switches songs, without a stale render", () => {
    saveMixerOpen("a", true);
    const seen: [string, boolean][] = [];
    const { result, rerender } = renderHook(
      ({ songId }) => {
        const mixer = useMixerToggle(true, songId);
        seen.push([songId, mixer.open]);
        return mixer;
      },
      { initialProps: { songId: "a" } },
    );
    expect(result.current.open).toBe(true);
    rerender({ songId: "b" });
    expect(result.current.open).toBe(false);
    expect(seen).not.toContainEqual(["b", true]);
    act(() => {
      result.current.toggle();
    });
    expect(loadMixerOpen("b")).toBe(true);
    act(() => {
      result.current.toggle();
    });
    expect(loadMixerOpen("b")).toBe(false);
    rerender({ songId: "a" });
    expect(result.current.open).toBe(true);
    expect(seen).not.toContainEqual(["a", false]);
  });

  it("starts closed and stores nothing for link visitors", () => {
    saveMixerOpen("a", true);
    const { result, rerender } = renderHook(({ remember }) => useMixerToggle(remember), {
      initialProps: { remember: false },
    });
    expect(result.current.open).toBe(false);
    act(() => {
      result.current.toggle();
    });
    expect(result.current.open).toBe(true);
    rerender({ remember: false });
    expect(result.current.open).toBe(true);
    expect(stored()).toEqual(["a"]);
  });

  it("keeps working without browser storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { result } = renderHook(() => useMixerToggle(true, "a"));
    expect(result.current.open).toBe(false);
    act(() => {
      result.current.toggle();
    });
    expect(result.current.open).toBe(true);
  });
});
