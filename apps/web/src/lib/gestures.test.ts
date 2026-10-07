import { afterEach, describe, expect, it, vi } from "vitest";
import { swallowNextClick } from "./gestures";

describe("swallowNextClick", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops only the first click, and none after the window", () => {
    vi.useFakeTimers();
    const seen = vi.fn();
    document.body.addEventListener("click", seen);
    swallowNextClick(400);
    document.body.click();
    document.body.click();
    expect(seen).toHaveBeenCalledTimes(1);
    swallowNextClick(400);
    vi.advanceTimersByTime(401);
    document.body.click();
    expect(seen).toHaveBeenCalledTimes(2);
    document.body.removeEventListener("click", seen);
  });
});
