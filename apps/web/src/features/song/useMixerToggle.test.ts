import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadMixerOpen, saveMixerOpen, useMixerToggle } from "./useMixerToggle";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("useMixerToggle", () => {
  it("starts from this device's choice and remembers each toggle", () => {
    saveMixerOpen(true);
    const { result } = renderHook(() => useMixerToggle(true));
    expect(result.current.open).toBe(true);
    act(() => {
      result.current.toggle();
    });
    expect(result.current.open).toBe(false);
    expect(loadMixerOpen()).toBe(false);
    act(() => {
      result.current.toggle();
    });
    expect(result.current.open).toBe(true);
    expect(loadMixerOpen()).toBe(true);
  });

  it("starts closed and stores nothing for link visitors", () => {
    saveMixerOpen(true);
    const { result } = renderHook(() => useMixerToggle(false));
    expect(result.current.open).toBe(false);
    act(() => {
      result.current.toggle();
    });
    expect(result.current.open).toBe(true);
    saveMixerOpen(false);
    act(() => {
      result.current.toggle();
    });
    expect(loadMixerOpen()).toBe(false);
  });

  it("keeps working without browser storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { result } = renderHook(() => useMixerToggle(true));
    expect(result.current.open).toBe(false);
    act(() => {
      result.current.toggle();
    });
    expect(result.current.open).toBe(true);
  });
});
