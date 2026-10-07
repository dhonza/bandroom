import { describe, expect, it, vi } from "vitest";
import { renderBootError } from "./bootError";

describe("renderBootError", () => {
  it("replaces the root with a static message and a reload button", () => {
    const root = document.createElement("div");
    root.textContent = "half-rendered";
    renderBootError(root);
    expect(root.querySelector("[role=alert] h1")?.textContent).toBe("The app could not start.");
    expect(root.textContent).not.toContain("half-rendered");
    const reload = vi.fn();
    vi.stubGlobal("location", { reload });
    root.querySelector("button")?.click();
    expect(reload).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
