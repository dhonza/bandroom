import { compileTempo, type TempoMap } from "@bandroom/shared";
import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { initI18n } from "../i18n/i18n";
import { fitAll } from "../timeline/view";
import { meterChangeMarks, RulerMeters, signatureMarks } from "./SignatureLane";

const i18n = i18next.createInstance();
beforeAll(async () => {
  await initI18n("en", i18n);
});

// 4/4 at 120 BPM (bar 1, 2 s), 4/4 at 60 BPM (bar 2, 4 s: no meter change), 7/8 from bar 3.
const map: TempoMap = {
  segments: [
    { startBeat: 0, bpm: 120, meter: { num: 4, den: 4 }, barIndex: 0 },
    { startBeat: 4, bpm: 60, meter: { num: 4, den: 4 }, barIndex: 1 },
    { startBeat: 8, bpm: 60, meter: { num: 7, den: 8 }, barIndex: 2 },
  ],
};
const grid = compileTempo({ map, bar1OffsetSec: 1 });

describe("meter changes on the ruler (SPEC §31.4)", () => {
  it("marks bar 1 and every meter change, not tempo changes", () => {
    const marks = signatureMarks(grid);
    expect(marks.map((m) => [m.bar, m.label])).toEqual([
      [1, "4/4"],
      [3, "7/8"],
    ]);
    expect(marks[0]?.sec).toBeCloseTo(1);
    expect(marks[1]?.sec).toBeCloseTo(7);
    expect(meterChangeMarks(grid).map((m) => m.label)).toEqual(["7/8"]);
    const one = compileTempo({ map: { segments: map.segments.slice(0, 1) }, bar1OffsetSec: 0 });
    expect(meterChangeMarks(one)).toEqual([]);
  });

  it("boxes the changes on the ruler's time axis; editors can open the tempo dialog", () => {
    const onOpen = vi.fn();
    const lane = (open: (() => void) | null) => (
      <I18nextProvider i18n={i18n}>
        <MantineProvider>
          <RulerMeters view={fitAll(10, 1000)} grid={grid} height={28} onOpen={open} />
        </MantineProvider>
      </I18nextProvider>
    );
    const view = render(lane(onOpen));
    const items = screen.getAllByTestId("signature-item");
    expect(items.map((el) => [el.dataset.x, el.textContent])).toEqual([["700", "7/8"]]);
    expect(items[0]?.getAttribute("aria-label")).toBe("Time signature 7/8 from bar 3");
    expect(items[0]?.getAttribute("data-timeline-item")).toBe("signature:1");
    if (items[0]) fireEvent.keyDown(items[0], { key: "Enter" });
    expect(onOpen).toHaveBeenCalledTimes(1);
    view.rerender(lane(null));
    const readOnly = screen.getAllByTestId("signature-item");
    expect(readOnly[0]?.getAttribute("role")).toBeNull();
    expect(readOnly[0]?.getAttribute("data-timeline-item")).toBeNull();
    view.unmount();
  });
});
