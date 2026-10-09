import { compileTempo, type TempoMap } from "@bandroom/shared";
import { MantineProvider } from "@mantine/core";
import { act, render, screen } from "@testing-library/react";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initI18n } from "../i18n/i18n";
import { meterLabel, MeterText } from "./readout";
import { resetTempoUiForTests, useTempoUi } from "./store";

const i18n = i18next.createInstance();
beforeAll(async () => {
  await initI18n("en", i18n);
});
afterEach(() => {
  resetTempoUiForTests();
  vi.unstubAllGlobals();
});

// Two bars of 4/4 at 120 BPM (4 s), then 7/8.
const map: TempoMap = {
  segments: [
    { startBeat: 0, bpm: 120, meter: { num: 4, den: 4 }, barIndex: 0 },
    { startBeat: 8, bpm: 120, meter: { num: 7, den: 8 }, barIndex: 2 },
  ],
};
const grid = compileTempo({ map, bar1OffsetSec: 0 });

describe("meter readout (SPEC §11.3)", () => {
  it("names the time signature at a position", () => {
    expect(meterLabel(grid, 0)).toBe("4/4");
    expect(meterLabel(grid, 3.9)).toBe("4/4");
    expect(meterLabel(grid, 4.1)).toBe("7/8");
  });

  it("follows the playhead in the DOM, writing only on a change; nothing without a map", () => {
    const frame: { cb: FrameRequestCallback | null } = { cb: null };
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frame.cb = cb;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    let pos = 1;
    const ui = (
      <I18nextProvider i18n={i18n}>
        <MantineProvider>
          <MeterText getPosition={() => pos} />
        </MantineProvider>
      </I18nextProvider>
    );
    const view = render(ui);
    expect(screen.queryByTestId("meter-readout")).toBeNull();
    act(() => {
      useTempoUi.setState({ songId: "s", grid });
    });
    const el = screen.getByTestId("meter-readout");
    const step = () => {
      frame.cb?.(0);
    };
    step();
    expect(el.textContent).toBe("4/4");
    // Same meter: the DOM is left alone (a marker written over it stays).
    el.textContent = "untouched";
    pos = 3;
    step();
    expect(el.textContent).toBe("untouched");
    pos = 5;
    step();
    expect(el.textContent).toBe("7/8");
    view.unmount();
  });
});
