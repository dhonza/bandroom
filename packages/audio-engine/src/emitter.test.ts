import { describe, expect, it } from "vitest";
import { Emitter } from "./emitter";

describe("Emitter", () => {
  it("delivers events to subscribers until they unsubscribe", () => {
    const e = new Emitter<{ n: number; s: string }>();
    const got: number[] = [];
    const off = e.on("n", (v) => got.push(v));
    e.emit("s", "ignored");
    e.emit("n", 1);
    off();
    e.emit("n", 2);
    expect(got).toEqual([1]);
  });
});
