import { compileTempo } from "@bandroom/shared";
import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { initI18n } from "../i18n/i18n";
import { mockApi } from "../test/mockApi";
import { useTempoUi } from "../tempo/store";
import { ClickToggles } from "./ClickControls";
import { useRehearse } from "./controller";

const i18n = i18next.createInstance();
const grid = compileTempo({
  map: { segments: [{ startBeat: 0, bpm: 120, meter: { num: 4, den: 4 }, barIndex: 0 }] },
  bar1OffsetSec: 0,
});

function renderToggles() {
  render(
    <I18nextProvider i18n={i18n}>
      <MantineProvider>
        <ClickToggles size={28} />
      </MantineProvider>
    </I18nextProvider>,
  );
}

describe("count-in and click icon toggles (SPEC §31.5)", () => {
  beforeAll(async () => {
    await initI18n("en", i18n);
  });
  beforeEach(() => {
    mockApi({});
    useRehearse.setState({ songId: "s1", previewSongId: null, mix: { tracks: {} } });
    useTempoUi.setState({ songId: "s1", tempo: null, grid, preview: false });
  });

  it("are icon buttons with aria-pressed and on/off tooltips", async () => {
    renderToggles();
    const countIn = screen.getByTestId("count-in-toggle");
    const click = screen.getByTestId("click-toggle");
    expect(countIn).toHaveAccessibleName("Count-in");
    expect(click).toHaveAccessibleName("Click");
    expect(countIn.textContent).toBe("");
    expect(click).toHaveAttribute("aria-pressed", "false");
    await userEvent.hover(click);
    expect(await screen.findByText("Click: off")).toBeInTheDocument();
    await userEvent.click(click);
    expect(click).toHaveAttribute("aria-pressed", "true");
    expect(click).toHaveAttribute("data-variant", "filled");
    expect(await screen.findByText("Click: on")).toBeInTheDocument();
    await userEvent.click(countIn);
    expect(useRehearse.getState().mix.click?.countIn).toBe(true);
  });

  it("are disabled without a tempo map", () => {
    useTempoUi.setState({ grid: null });
    renderToggles();
    expect(screen.getByTestId("count-in-toggle")).toBeDisabled();
    expect(screen.getByTestId("click-toggle")).toBeDisabled();
  });
});
