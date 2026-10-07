import { describe, expect, it } from "vitest";
import { buildPyramid, parseDat, pickLevel, rangePeak } from "./peaks";
import { clipColumn } from "./render";
import {
  centerOn,
  clampSec,
  clampView,
  fitAll,
  fitRange,
  follow,
  formatRuler,
  MAX_PX_PER_SEC,
  rulerStep,
  scrollBy,
  secToX,
  viewportOn,
  wheelView,
  xToSec,
  zoomAt,
} from "./view";

function dat(pairs: number[], sampleRate = 48_000, spp = 256): ArrayBuffer {
  const buf = new ArrayBuffer(20 + pairs.length);
  const dv = new DataView(buf);
  dv.setInt32(0, 1, true);
  dv.setUint32(4, 1, true);
  dv.setInt32(8, sampleRate, true);
  dv.setInt32(12, spp, true);
  dv.setUint32(16, pairs.length / 2, true);
  new Int8Array(buf, 20).set(pairs);
  return buf;
}

describe("peaks pyramid", () => {
  it("parses .dat and halves resolution per level", () => {
    const base = parseDat(dat([-1, 1, -5, 3, -2, 8, 0, 0, -9, 2]));
    expect(Array.from(base.mins)).toEqual([-1, -5, -2, 0, -9]);
    const p = buildPyramid(base, 1);
    expect(p.levels.map((l) => l.spp)).toEqual([256, 512, 1024, 2048]);
    expect(Array.from(p.levels[1]?.mins ?? [])).toEqual([-5, -2, -9]);
    expect(Array.from(p.levels[1]?.maxs ?? [])).toEqual([3, 8, 2]);
    expect(p.lengthSamples).toBe(5 * 256);
    expect(() => parseDat(new ArrayBuffer(20))).toThrow();
  });

  it("picks the coarsest level still finer than a pixel and aggregates ranges", () => {
    const p = buildPyramid(parseDat(dat([-1, 1, -5, 3, -2, 8, 0, 0])), 1);
    expect(pickLevel(p, 100).spp).toBe(256);
    expect(pickLevel(p, 600).spp).toBe(512);
    const l0 = p.levels[0];
    if (!l0) throw new Error("level");
    expect(rangePeak(l0, 0, 512)).toEqual([-5, 3]);
    expect(rangePeak(l0, 300, 301)).toEqual([-5, 3]);
    expect(rangePeak(l0, 5000, 6000)).toBeNull();
  });
});

describe("timeline view", () => {
  const base = { startSec: 0, pxPerSec: 10, widthPx: 1000, durationSec: 300 };

  it("fits the song and clamps zoom and scroll", () => {
    expect(fitAll(300, 1000)).toMatchObject({ startSec: 0, pxPerSec: 1000 / 300 });
    expect(clampView({ ...base, pxPerSec: 1 }).pxPerSec).toBeCloseTo(1000 / 300);
    expect(clampView({ ...base, pxPerSec: 1e6 }).pxPerSec).toBe(MAX_PX_PER_SEC);
    expect(clampView({ ...base, startSec: 999 }).startSec).toBe(200);
    expect(clampView({ ...base, startSec: -5 }).startSec).toBe(0);
  });

  it("converts between time and pixels and zooms around an anchor", () => {
    const v = { ...base, startSec: 10 };
    expect(secToX(v, 20)).toBe(100);
    expect(xToSec(v, 100)).toBe(20);
    const z = zoomAt(v, 100, 2);
    expect(z.pxPerSec).toBe(20);
    expect(xToSec(z, 100)).toBeCloseTo(20);
    expect(scrollBy(v, 50).startSec).toBe(15);
  });

  it("follows the playhead by paging", () => {
    const v = { ...base, startSec: 0 };
    expect(follow(v, 50)).toBe(v);
    expect(follow(v, 90).startSec).toBeCloseTo(90 - 15);
  });

  it("clamps times, centers on a time and places the viewport on the overview", () => {
    expect(clampSec(-1, 300)).toBe(0);
    expect(clampSec(301, 300)).toBe(300);
    expect(clampSec(12, 300)).toBe(12);
    expect(centerOn(base, 100).startSec).toBe(50);
    expect(centerOn(base, 10).startSec).toBe(0);
    const all = fitAll(300, 1000);
    const vp = viewportOn(all, { ...base, startSec: 30 });
    expect(vp.x0).toBeCloseTo(100);
    expect(vp.x1).toBeCloseTo(433.33, 1);
  });

  it("zooms with Ctrl/Cmd wheel and scrolls with a horizontal or Shift wheel", () => {
    const keys = { ctrlKey: false, metaKey: false, shiftKey: false };
    const v = { ...base, startSec: 10 };
    const zoom = wheelView(v, { ...keys, ctrlKey: true, x: 100, deltaX: 0, deltaY: -100 });
    expect(zoom?.zoom).toBe(true);
    expect(zoom?.view.pxPerSec).toBeCloseTo(10 * Math.E);
    expect(wheelView(v, { ...keys, metaKey: true, x: 0, deltaX: 0, deltaY: 0 })?.zoom).toBe(true);
    const h = wheelView(v, { ...keys, x: 0, deltaX: 50, deltaY: 10 });
    expect(h).toEqual({ view: scrollBy(v, 50), zoom: false });
    const shift = wheelView(v, { ...keys, shiftKey: true, x: 0, deltaX: 0, deltaY: 30 });
    expect(shift).toEqual({ view: scrollBy(v, 30), zoom: false });
    expect(wheelView(v, { ...keys, x: 0, deltaX: 5, deltaY: 50 })).toBeNull();
  });

  it("chooses readable ruler steps and formats labels", () => {
    expect(rulerStep(10)).toBe(10);
    expect(rulerStep(1000)).toBe(0.1);
    expect(formatRuler(75, 5)).toBe("1:15");
    expect(formatRuler(61.5, 0.5)).toBe("1:01.5");
  });
});

describe("waveform clipping (SPEC §25.6)", () => {
  it("limits a column scaled by the version gain to the lane and reports the clip", () => {
    expect(clipColumn(20, 40, 10, 50)).toEqual([20, 40, false]);
    expect(clipColumn(-30, 40, 10, 50)).toEqual([10, 40, true]);
    expect(clipColumn(5, 90, 10, 50)).toEqual([10, 50, true]);
  });
});

describe("fitRange (zoom to loop, SPEC §25.8)", () => {
  const v = fitAll(200, 1000);
  const shown = (x: ReturnType<typeof fitRange>): [number, number] => [
    x.startSec,
    x.startSec + x.widthPx / x.pxPerSec,
  ];

  it("shows the range with 10 % of its length on each side", () => {
    const z = fitRange(v, 50, 70);
    expect(shown(z)[0]).toBeCloseTo(48, 6);
    expect(shown(z)[1]).toBeCloseTo(72, 6);
  });

  it("uses at least 1 s of margin and accepts the range backwards", () => {
    const z = fitRange(v, 12, 10);
    expect(shown(z)[0]).toBeCloseTo(9, 6);
    expect(shown(z)[1]).toBeCloseTo(13, 6);
  });

  it("clamps the margin to the song", () => {
    const start = fitRange(v, 0.5, 10.5);
    expect(shown(start)[0]).toBe(0);
    expect(shown(start)[1]).toBeCloseTo(11.5, 6);
    const end = fitRange(v, 190, 199.5);
    expect(shown(end)[1]).toBeCloseTo(200, 6);
    expect(shown(end)[0]).toBeCloseTo(189, 6);
    expect(fitRange(v, 0, 200)).toEqual(v);
  });

  it("centres a range too short for the closest zoom", () => {
    const z = fitRange(fitAll(200, 10_000), 100, 100.001);
    expect(z.pxPerSec).toBe(MAX_PX_PER_SEC);
    const [a, b] = shown(z);
    expect((a + b) / 2).toBeCloseTo(100.0005, 6);
  });
});
