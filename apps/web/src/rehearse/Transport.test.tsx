import { compileTempo, type TempoMap } from "@bandroom/shared";
import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { initI18n } from "../i18n/i18n";
import { sectionPillsOn, useSectionPills } from "../markers/pillsStore";
import { mockApi } from "../test/mockApi";
import { useTempoUi } from "../tempo/store";
import type { BarLayout } from "./barLayout";
import { useRehearse } from "./controller";
import { ControlBar } from "./Transport";

const i18n = i18next.createInstance();
const m = (num: number, den: number) => ({ num, den });
const oneMeter: TempoMap = { segments: [{ startBeat: 0, bpm: 120, meter: m(4, 4), barIndex: 0 }] };
const changing: TempoMap = {
  segments: [
    { startBeat: 0, bpm: 120, meter: m(4, 4), barIndex: 0 },
    { startBeat: 8, bpm: 120, meter: m(7, 8), barIndex: 2 },
  ],
};

function renderBar(layout: BarLayout) {
  render(
    <I18nextProvider i18n={i18n}>
      <MantineProvider>
        <MemoryRouter>
          <ControlBar
            layout={layout}
            coarse={layout !== "desktop"}
            contextRow={<div data-testid="row-two" />}
          />
        </MemoryRouter>
      </MantineProvider>
    </I18nextProvider>,
  );
}

const setMap = (map: TempoMap) => {
  useTempoUi.setState({
    songId: "s1",
    tempo: null,
    grid: compileTempo({ map, bar1OffsetSec: 0 }),
    preview: false,
  });
};

describe("control bar (SPEC §31.1, §31.5)", () => {
  beforeAll(async () => {
    await initI18n("en", i18n);
  });
  beforeEach(() => {
    mockApi({});
    useRehearse.setState({ songId: "s1", previewSongId: null, mix: { tracks: {} } });
    useSectionPills.setState({ byUser: {} });
  });

  it("shows the meter only when the song changes meter, on every layout", () => {
    for (const layout of ["desktop", "phone", "landscape"] as const) {
      setMap(oneMeter);
      renderBar(layout);
      expect(screen.queryByTestId("meter-readout")).toBeNull();
      expect(screen.getByTestId("bar-beat")).toBeInTheDocument();
      document.body.innerHTML = "";
      setMap(changing);
      renderBar(layout);
      expect(screen.getByTestId("meter-readout")).toBeInTheDocument();
      document.body.innerHTML = "";
    }
  });

  it("has the context row in the sticky box", () => {
    setMap(oneMeter);
    renderBar("desktop");
    const bar = screen.getByTestId("rehearse-transport");
    expect(bar).toHaveStyle({ position: "sticky" });
    expect(bar).toContainElement(screen.getByTestId("row-two"));
    expect(screen.getByTestId("count-in-toggle")).toBeInTheDocument();
  });

  it("phones: bar.beat in row 1 and the readout toggles the section pills", async () => {
    setMap(oneMeter);
    renderBar("phone");
    const readout = screen.getByTestId("transport-readout");
    expect(readout).toContainElement(screen.getByTestId("bar-beat"));
    expect(readout).toHaveAttribute("aria-pressed", "false");
    // Phones have count-in and click in row 2, not row 1.
    expect(screen.queryByTestId("count-in-toggle")).toBeNull();
    await userEvent.click(readout);
    expect(sectionPillsOn("link")).toBe(true);
    expect(readout).toHaveAttribute("aria-pressed", "true");
  });
});
