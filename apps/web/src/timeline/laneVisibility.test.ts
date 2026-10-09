import { beforeEach, describe, expect, it, vi } from "vitest";
import { reloadLaneVisibility, setAllLanes, toggleLane, useLaneVisibility } from "./laneVisibility";

beforeEach(() => {
  localStorage.clear();
  reloadLaneVisibility();
});

const hidden = () => useLaneVisibility.getState().hidden;

describe("lane visibility (SPEC §11.3)", () => {
  it("shows every lane by default", () => {
    expect(hidden()).toEqual({
      signature: false,
      sections: false,
      markers: false,
      comments: false,
    });
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
    expect(Object.values(hidden())).toEqual([true, true, true, true]);
    setAllLanes(false);
    expect(Object.values(hidden())).toEqual([false, false, false, false]);
    expect(localStorage.getItem("bandroom.hiddenLanes")).toBe("[]");
  });

  it("ignores unknown or broken stored values", () => {
    localStorage.setItem("bandroom.hiddenLanes", '["markers","bogus",3]');
    reloadLaneVisibility();
    expect(hidden()).toEqual({ signature: false, sections: false, markers: true, comments: false });
    localStorage.setItem("bandroom.hiddenLanes", "{not json");
    reloadLaneVisibility();
    expect(hidden().markers).toBe(false);
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
