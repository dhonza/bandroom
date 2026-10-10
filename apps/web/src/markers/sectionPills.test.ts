import { afterEach, describe, expect, it, vi } from "vitest";
import {
  sectionPillsOn,
  setSectionPills,
  toggleSectionPills,
  useSectionPills,
} from "./sectionPills";

afterEach(() => {
  localStorage.clear();
  useSectionPills.setState({ byUser: {} });
  vi.restoreAllMocks();
});

describe("section pills store (SPEC §31.3)", () => {
  it("is off by default and remembered per user", () => {
    expect(sectionPillsOn("a")).toBe(false);
    toggleSectionPills("a");
    expect(sectionPillsOn("a")).toBe(true);
    expect(sectionPillsOn("b")).toBe(false);
    // A reload reads the stored choice.
    useSectionPills.setState({ byUser: {} });
    expect(sectionPillsOn("a")).toBe(true);
    expect(sectionPillsOn("b")).toBe(false);
    setSectionPills("a", false);
    useSectionPills.setState({ byUser: {} });
    expect(sectionPillsOn("a")).toBe(false);
  });

  it("lasts for the page when storage fails", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(sectionPillsOn("a")).toBe(false);
    toggleSectionPills("a");
    expect(sectionPillsOn("a")).toBe(true);
  });
});
