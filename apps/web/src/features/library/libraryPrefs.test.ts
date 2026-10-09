import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LIBRARY_PREFS, loadLibraryPrefs, saveLibraryPrefs } from "./libraryPrefs";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("library prefs", () => {
  it("round-trips through localStorage", () => {
    const prefs = { view: "list", sort: "accessed", order: "asc", filter: "mine" } as const;
    saveLibraryPrefs(prefs);
    expect(loadLibraryPrefs()).toEqual(prefs);
  });

  it("falls back to defaults for missing, invalid or unknown values", () => {
    expect(loadLibraryPrefs()).toEqual(DEFAULT_LIBRARY_PREFS);
    localStorage.setItem("bandroom.library.prefs", "{not json");
    expect(loadLibraryPrefs()).toEqual(DEFAULT_LIBRARY_PREFS);
    localStorage.setItem("bandroom.library.prefs", JSON.stringify({ view: "list", sort: "size" }));
    expect(loadLibraryPrefs()).toEqual({ ...DEFAULT_LIBRARY_PREFS, view: "list" });
  });

  it("survives blocked storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => {
      saveLibraryPrefs(DEFAULT_LIBRARY_PREFS);
    }).not.toThrow();
    expect(loadLibraryPrefs()).toEqual(DEFAULT_LIBRARY_PREFS);
  });
});
