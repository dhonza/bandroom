import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import type { ReactNode } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import { initI18n } from "../i18n/i18n";
import { overviewLanes, type Lane } from "./render";
import { Timeline } from "./Timeline";
import { detailLayout, OVERVIEW_H, RULER_H } from "./types";

const i18n = i18next.createInstance();
beforeAll(async () => {
  await initI18n("en", i18n);
});

const lane = (id: string, dimmed = false): Lane => ({
  id,
  color: "blue",
  offsetSamples: 0,
  peaks: null,
  dimmed,
});

describe("detail layout (SPEC §11.3)", () => {
  it("stacks the ruler, the top lanes and one row per lane", () => {
    expect(
      detailLayout({ laneCount: 3, laneHeight: 50, topLanesHeight: 40, hideLanes: false }),
    ).toEqual({ lanesTop: RULER_H + 40, shownLanes: 3, height: RULER_H + 40 + 150 });
  });

  it("keeps one row for a timeline without lanes", () => {
    expect(
      detailLayout({ laneCount: 0, laneHeight: 50, topLanesHeight: 0, hideLanes: false }),
    ).toMatchObject({ shownLanes: 1, height: RULER_H + 50 });
  });

  it("has no lane rows when the lanes are hidden (Mixer closed)", () => {
    expect(
      detailLayout({ laneCount: 4, laneHeight: 80, topLanesHeight: 40, hideLanes: true }),
    ).toEqual({ lanesTop: RULER_H + 40, shownLanes: 0, height: RULER_H + 40 });
  });
});

describe("overview lanes", () => {
  it("sums only the audible lanes (muted and solo-silenced lanes are dimmed)", () => {
    const lanes = [lane("a"), lane("b", true), lane("c")];
    expect(overviewLanes(lanes).map((l) => l.id)).toEqual(["a", "c"]);
    expect(overviewLanes([lane("x", true)])).toEqual([]);
  });

  it("never sums the click lane", () => {
    const click = { ...lane("click"), click: {} as Lane["click"] };
    expect(overviewLanes([lane("a"), click]).map((l) => l.id)).toEqual(["a"]);
  });
});

describe("Timeline props", () => {
  const timeline = (props: {
    hideLanes?: boolean;
    overviewHeight?: number;
    topLanesHeight?: number;
    labelWidth?: number;
    renderCorner?: () => ReactNode;
  }) => (
    <I18nextProvider i18n={i18n}>
      <MantineProvider>
        <Timeline
          lanes={[lane("a"), lane("b")]}
          durationSec={60}
          getPosition={() => 0}
          playing={false}
          onSeek={() => undefined}
          renderHeader={(i) => <span>{`header ${String(i)}`}</span>}
          headerWidth={120}
          belowOverview={<span>tools</span>}
          renderTopHeader={() => <span>top labels</span>}
          {...props}
        />
      </MantineProvider>
    </I18nextProvider>
  );

  it("shows the lanes with their headers by default", () => {
    const view = render(timeline({}));
    expect(screen.getByTestId("timeline").getAttribute("data-lanes")).toBe("2");
    expect(screen.getByTestId("track-headers")).toBeTruthy();
    expect(screen.getByText("header 1")).toBeTruthy();
    expect(screen.getByTestId("timeline-overview").style.height).toBe(`${String(OVERVIEW_H)}px`);
    view.unmount();
  });

  it("hides the lanes and their headers, keeping the overview at the given height", () => {
    const view = render(timeline({ hideLanes: true, overviewHeight: 80 }));
    expect(screen.getByTestId("timeline").getAttribute("data-lanes")).toBe("0");
    expect(screen.queryByTestId("track-headers")).toBeNull();
    expect(screen.queryByText("header 0")).toBeNull();
    expect(screen.getByTestId("timeline").getAttribute("data-overview-height")).toBe("80");
    expect(screen.getByTestId("timeline-overview").style.height).toBe("80px");
    // The row below the overview (the Mixer tools) is the caller's choice.
    expect(screen.getByText("tools")).toBeTruthy();
    view.unmount();
  });

  it("keeps the labels in the track-header column with the Mixer open", () => {
    const view = render(timeline({ topLanesHeight: 54, labelWidth: 88 }));
    expect(screen.getByTestId("track-headers").style.width).toBe(remOf(120));
    expect(screen.getByText("top labels")).toBeTruthy();
    expect(screen.queryByTestId("lane-labels")).toBeNull();
    view.unmount();
  });

  it("puts the top-lane labels in a narrow column with the Mixer closed", () => {
    const view = render(timeline({ hideLanes: true, topLanesHeight: 54, labelWidth: 88 }));
    expect(screen.getByTestId("lane-labels").style.width).toBe(remOf(88));
    expect(screen.getByText("top labels")).toBeTruthy();
    expect(screen.queryByText("header 0")).toBeNull();
    view.unmount();
  });

  it("has no label column when no top lane has items", () => {
    const view = render(timeline({ hideLanes: true, topLanesHeight: 0, labelWidth: 88 }));
    expect(screen.queryByTestId("lane-labels")).toBeNull();
    expect(screen.queryByText("top labels")).toBeNull();
    expect(screen.queryByTestId("timeline-corner")).toBeNull();
    view.unmount();
  });

  it("keeps the label column for the corner (lanes menu) when every top lane is hidden", () => {
    const view = render(
      timeline({
        hideLanes: true,
        topLanesHeight: 0,
        labelWidth: 88,
        renderCorner: () => <span>lanes menu</span>,
      }),
    );
    expect(screen.getByTestId("lane-labels").style.width).toBe(remOf(88));
    expect(screen.getByTestId("timeline-corner").style.width).toBe(remOf(88));
    expect(screen.getByText("lanes menu")).toBeTruthy();
    expect(screen.queryByText("top labels")).toBeNull();
    view.unmount();
  });

  it("puts the corner above the track headers with the Mixer open", () => {
    const view = render(timeline({ renderCorner: () => <span>lanes menu</span> }));
    expect(screen.getByTestId("timeline-corner").style.width).toBe(remOf(120));
    view.unmount();
  });
});

/** Mantine's `w={px}` style value. */
function remOf(px: number): string {
  return `calc(${String(px / 16)}rem * var(--mantine-scale))`;
}
