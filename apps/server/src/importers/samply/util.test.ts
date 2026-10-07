import { describe, expect, it } from "vitest";
import { orderedPool, paletteFromHex } from "./util";

describe("paletteFromHex", () => {
  it("maps hues to the nearest palette color", () => {
    expect(paletteFromHex("#ff0000")).toBe("red");
    expect(paletteFromHex("#ff8000")).toBe("orange");
    expect(paletteFromHex("#ffdd00")).toBe("yellow");
    expect(paletteFromHex("#00ff00")).toBe("green");
    expect(paletteFromHex("#00ccaa")).toBe("teal");
    expect(paletteFromHex("0066ff")).toBe("blue");
    expect(paletteFromHex("#7a3cff")).toBe("violet");
    expect(paletteFromHex("#ff33cc")).toBe("pink");
    expect(paletteFromHex("#ff0022")).toBe("red"); // wraps around 360°
    expect(paletteFromHex("#88cc22")).toBe("lime");
    expect(paletteFromHex("#11bbdd")).toBe("cyan");
    expect(paletteFromHex("#3344ff")).toBe("indigo");
    expect(paletteFromHex("#bb33ee")).toBe("grape");
  });

  it("defaults to violet for grey, invalid or missing colors", () => {
    expect(paletteFromHex("#808080")).toBe("violet");
    expect(paletteFromHex("#fff")).toBe("violet");
    expect(paletteFromHex("nope")).toBe("violet");
    expect(paletteFromHex(null)).toBe("violet");
    expect(paletteFromHex(undefined)).toBe("violet");
  });
});

describe("orderedPool", () => {
  it("commits in list order while bounding the work in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const committed: number[] = [];
    await orderedPool(
      [30, 5, 20, 1, 10],
      2,
      async (ms) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, ms));
        inFlight--;
        return ms * 2;
      },
      (item, result) => {
        expect(result).toEqual({ status: "fulfilled", value: item * 2 });
        committed.push(item);
      },
    );
    expect(committed).toEqual([30, 5, 20, 1, 10]);
    expect(peak).toBe(2);
  });

  it("hands rejections to commit instead of throwing", async () => {
    const results: PromiseSettledResult<number>[] = [];
    await orderedPool(
      [1, 2],
      3,
      (n) => (n === 1 ? Promise.reject(new Error("boom")) : Promise.resolve(n)),
      (_item, result) => {
        results.push(result);
      },
    );
    expect(results[0]?.status).toBe("rejected");
    expect(results[1]).toEqual({ status: "fulfilled", value: 2 });
  });

  it("does nothing for an empty list", async () => {
    let calls = 0;
    await orderedPool(
      [],
      2,
      () => Promise.resolve(calls++),
      () => {
        calls++;
      },
    );
    expect(calls).toBe(0);
  });
});
