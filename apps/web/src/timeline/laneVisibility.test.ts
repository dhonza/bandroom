import { beforeEach, describe, expect, it, vi } from "vitest";
import { reloadLaneVisibility, setAllLanes, toggleLane, useLaneVisibility } from "./laneVisibility";

beforeEach(() => {
  localStorage.clear();
  reloadLaneVisibility();
});

const hidden = () => useLaneVisibility.getState().hidden;

describe("lane visibility (SPEC §11.3)", () => {
  it("shows every lane by default", () => {
    expect(hidden()).toEqual({ sections: false, comments: false });
  });

  it("toggles one lane and remembers it on this device", () => {
    toggleLane("comments");
    expect(hidden().comments).toBe(true);
    expect(JSON.parse(localStorage.getItem("bandroom.hiddenLanes") ?? "")).toEqual(["comments"]);
    useLaneVisibility.setState({ hidden: { ...hidden(), comments: false } });
    reloadLaneVisibility();
    expect(hidden().comments).toBe(true);
    toggleLane("comments");
    expect(hidden().comments).toBe(false);
  });

  it("hides and shows all lanes", () => {
    setAllLanes(true);
    expect(Object.values(hidden())).toEqual([true, true]);
    setAllLanes(false);
    expect(Object.values(hidden())).toEqual([false, false]);
    expect(localStorage.getItem("bandroom.hiddenLanes")).toBe("[]");
  });

  it("ignores unknown or broken stored values", () => {
    // "markers" and "signature" were lanes before SPEC §31.4: ignored now.
    localStorage.setItem("bandroom.hiddenLanes", '["markers","sections","bogus",3]');
    reloadLaneVisibility();
    expect(hidden()).toEqual({ sections: true, comments: false });
    localStorage.setItem("bandroom.hiddenLanes", "{not json");
    reloadLaneVisibility();
    expect(hidden().sections).toBe(false);
  });

  it("works for the page only when storage is unavailable", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("private mode");
    });
    toggleLane("sections");
    expect(hidden().sections).toBe(true);
    spy.mockRestore();
  });
});
