import { compileTempo } from "@bandroom/shared";
import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n } from "../i18n/i18n";
import { mockApi } from "../test/mockApi";
import { setPhoneViewport } from "../test/setup";
import { useTempoUi } from "../tempo/store";
import { ClickToggles } from "./ClickControls";
import { ClickStrip } from "./ClickStrip";
import { useRehearse } from "./controller";

const i18n = i18next.createInstance();

function renderStrip(height = 100, compact = false) {
  render(
    <I18nextProvider i18n={i18n}>
      <MantineProvider>
        <ClickToggles />
        <div style={{ height }}>
          <ClickStrip height={height} compact={compact} />
        </div>
      </MantineProvider>
    </I18nextProvider>,
  );
}

const click = () => useRehearse.getState().mix.click;

describe("ClickStrip (SPEC §11.3, DECISIONS 2026-10-07)", () => {
  beforeAll(async () => {
    await initI18n("en", i18n);
  });
  beforeEach(() => {
    mockApi({});
    useRehearse.setState({ songId: "s1", previewSongId: null, mix: { tracks: {} } });
    useTempoUi.setState({
      songId: "s1",
      tempo: null,
      grid: compileTempo({
        map: { segments: [{ startBeat: 0, bpm: 120, meter: { num: 4, den: 4 }, barIndex: 0 }] },
        bar1OffsetSec: 0,
      }),
      preview: false,
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("M is the transport's Click toggle switched off, both ways", async () => {
    renderStrip();
    const mute = screen.getByTestId("click-mute");
    const toggle = screen.getByTestId("click-toggle");
    // The click is off by default: muted in its lane.
    expect(mute).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(mute);
    expect(click()?.enabled).toBe(true);
    expect(mute).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(toggle);
    expect(mute).toHaveAttribute("aria-pressed", "true");
    expect(click()?.enabled).toBe(false);
  });

  it("S is the click solo; the fader is the click volume", async () => {
    renderStrip();
    const solo = screen.getByTestId("click-solo");
    await userEvent.click(solo);
    expect(click()?.solo).toBe(true);
    expect(solo).toHaveAttribute("aria-pressed", "true");
    const thumb = screen.getByRole("slider", { name: "Click volume" });
    expect(thumb).toHaveAttribute("aria-valuenow", "-6");
    thumb.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(click()?.gainDb).toBe(-5);
  });

  it("phones: the header opens the click settings full screen with the volume", async () => {
    setPhoneViewport(true);
    renderStrip(66, true);
    expect(screen.getByTestId("click-strip")).toHaveAttribute("data-tier", "two");
    expect(screen.queryByTestId("click-fader")).toBeNull();
    await userEvent.click(screen.getByTestId("click-strip-settings"));
    expect(await screen.findByTestId("click-settings")).toBeInTheDocument();
    // Exactly one click volume fader in the panel: the strip's, not the form's as well.
    expect(screen.getAllByRole("slider", { name: "Click volume" })).toHaveLength(1);
    expect(screen.getAllByText("Click volume")).toHaveLength(1);
    expect(screen.getByTestId("click-fader")).toBeInTheDocument();
    expect(document.querySelector("[data-sheet='true']")).not.toBeNull();
    setPhoneViewport(false);
  });
});
