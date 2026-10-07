import { describe, expect, it } from "vitest";
import {
  Bar1OffsetSchema,
  barQuarters,
  beatQuarters,
  beatsPerBar,
  constantTempoMap,
  formatMeter,
  isCompound,
  MeterSchema,
  normalizeSegments,
  sameMeter,
  TempoMapSchema,
} from "./model";

const m = (num: number, den: number) => ({ num, den });

describe("meters (SPEC §6.7, §7.1)", () => {
  it("knows bar lengths, compound meters and counted beats", () => {
    expect(barQuarters(m(4, 4))).toBe(4);
    expect(barQuarters(m(6, 8))).toBe(3);
    expect(barQuarters(m(7, 8))).toBe(3.5);
    expect(isCompound(m(6, 8))).toBe(true);
    expect(isCompound(m(12, 8))).toBe(true);
    expect(isCompound(m(9, 16))).toBe(true);
    expect(isCompound(m(3, 8))).toBe(false);
    expect(isCompound(m(6, 4))).toBe(false);
    expect(isCompound(m(7, 8))).toBe(false);
    expect(beatQuarters(m(6, 8))).toBe(1.5);
    expect(beatQuarters(m(3, 4))).toBe(1);
    expect(beatQuarters(m(7, 8))).toBe(0.5);
    expect(beatsPerBar(m(6, 8))).toBe(2);
    expect(beatsPerBar(m(12, 8))).toBe(4);
    expect(beatsPerBar(m(7, 8))).toBe(7);
    expect(sameMeter(m(3, 4), m(3, 4))).toBe(true);
    expect(sameMeter(m(3, 4), m(6, 8))).toBe(false);
    expect(formatMeter(m(6, 8))).toBe("6/8");
  });

  it("validates meters and the bar 1 offset", () => {
    expect(MeterSchema.safeParse(m(4, 4)).success).toBe(true);
    expect(MeterSchema.safeParse(m(4, 3)).success).toBe(false);
    expect(MeterSchema.safeParse(m(0, 4)).success).toBe(false);
    expect(Bar1OffsetSchema.safeParse(1.234).success).toBe(true);
    expect(Bar1OffsetSchema.safeParse(-61).success).toBe(false);
  });
});

describe("normalizeSegments (SPEC §7.1 rules)", () => {
  it("fills bar indexes across meter changes and tempo changes inside bars", () => {
    const r = normalizeSegments([
      { startBeat: 0, bpm: 120, meter: m(4, 4) },
      { startBeat: 6, bpm: 100, meter: m(4, 4) }, // mid bar 2
      { startBeat: 8, bpm: 100, meter: m(3, 4) }, // bar 3
      { startBeat: 14, bpm: 90, bpmEnd: 90, meter: m(6, 8) }, // bar 5; equal ramp is dropped
      { startBeat: 18.5, bpm: 90, bpmEnd: 120, meter: m(6, 8) },
      { startBeat: 20, bpm: 120, meter: m(6, 8) },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.segments.map((s) => s.barIndex)).toEqual([0, 1, 2, 4, 5, 6]);
    expect(r.segments[3]?.bpmEnd).toBeUndefined();
    expect(r.segments[4]?.bpmEnd).toBe(120);
  });

  it("rejects empty, shifted, unordered, off-bar meter changes and a ramp at the end", () => {
    const four = m(4, 4);
    expect(normalizeSegments([])).toEqual({ ok: false, issue: { code: "empty" } });
    expect(normalizeSegments([{ startBeat: 1, bpm: 120, meter: four }])).toEqual({
      ok: false,
      issue: { code: "firstNotZero" },
    });
    expect(
      normalizeSegments([
        { startBeat: 0, bpm: 120, meter: four },
        { startBeat: 8, bpm: 100, meter: four },
        { startBeat: 8, bpm: 90, meter: four },
      ]),
    ).toEqual({ ok: false, issue: { code: "order", index: 2 } });
    expect(
      normalizeSegments([
        { startBeat: 0, bpm: 120, meter: four },
        { startBeat: 6, bpm: 120, meter: m(3, 4) },
      ]),
    ).toEqual({ ok: false, issue: { code: "meterOffBar", index: 1 } });
    expect(normalizeSegments([{ startBeat: 0, bpm: 120, bpmEnd: 140, meter: four }])).toEqual({
      ok: false,
      issue: { code: "rampAtEnd" },
    });
  });

  it("parses maps with the schema and reports invalid ones", () => {
    const parsed = TempoMapSchema.parse({
      segments: [
        { startBeat: 0, bpm: 120, meter: m(4, 4), barIndex: 7 },
        { startBeat: 8, bpm: 120, meter: m(3, 4) },
      ],
    });
    expect(parsed.segments.map((s) => s.barIndex)).toEqual([0, 2]);
    expect(
      TempoMapSchema.safeParse({ segments: [{ startBeat: 0, bpm: 5, meter: m(4, 4) }] }).success,
    ).toBe(false);
    expect(
      TempoMapSchema.safeParse({
        segments: [
          { startBeat: 0, bpm: 120, meter: m(4, 4) },
          { startBeat: 3, bpm: 120, meter: m(3, 4) },
        ],
      }).success,
    ).toBe(false);
    expect(constantTempoMap(97.5, m(6, 8))).toEqual({
      segments: [{ startBeat: 0, bpm: 97.5, meter: m(6, 8), barIndex: 0 }],
    });
  });
});
