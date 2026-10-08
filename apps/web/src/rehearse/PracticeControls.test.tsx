import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { initI18n } from "../i18n/i18n";
import { useRehearse, type RehearseState } from "./controller";
import { practiceLabel, PracticeForm, practiceShortcut } from "./PracticeControls";

const i18n = i18next.createInstance();

function renderForm() {
  render(
    <I18nextProvider i18n={i18n}>
      <MantineProvider>
        <PracticeForm />
      </MantineProvider>
    </I18nextProvider>,
  );
}

const practice = () => useRehearse.getState().mix.practice;

describe("Practice (SPEC §30.6)", () => {
  beforeAll(async () => {
    await initI18n("en", i18n);
  });
  beforeEach(() => {
    useRehearse.setState({
      songId: null,
      mix: { tracks: {} },
      tracks: [],
    } as Partial<RehearseState>);
  });

  it("labels only what differs from the original", () => {
    const t = i18n.t.bind(i18n);
    expect(practiceLabel(t, { rate: 0.85, semitones: -2, cents: 8 })).toBe("85 % · −2 st · +8 ct");
    expect(practiceLabel(t, { rate: 1, semitones: 3, cents: 0 })).toBe("+3 st");
  });

  it("sets speed presets, pitch steps, tuning helpers and resets", async () => {
    const user = userEvent.setup();
    renderForm();
    expect(screen.getByTestId("practice-reset")).toBeDisabled();
    await user.click(screen.getByTestId("practice-preset-75"));
    expect(practice()).toMatchObject({ rate: 0.75 });
    await user.click(screen.getByTestId("practice-pitch-down"));
    await user.click(screen.getByTestId("practice-pitch-down"));
    expect(practice()).toMatchObject({ semitones: -2 });
    expect(screen.getByTestId("practice-pitch-value")).toHaveTextContent("−2 semitones");
    await user.click(screen.getByTestId("practice-tune-432"));
    expect(practice()).toMatchObject({ cents: -32 });
    await user.click(screen.getByTestId("practice-speed-up"));
    expect(practice()).toMatchObject({ rate: 0.76 });
    await user.click(screen.getByTestId("practice-reset"));
    expect(practice()).toEqual({ rate: 1, semitones: 0, cents: 0 });
  });

  it("hints at extreme speeds", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(screen.getByTestId("practice-preset-50"));
    expect(screen.queryByTestId("practice-hint")).toBeNull();
    for (let i = 0; i < 6; i++) practiceShortcut("practiceSlower");
    expect(practice()).toMatchObject({ rate: 0.25 });
    expect(await screen.findByTestId("practice-hint")).toHaveTextContent(/quality drops/);
  });

  it("runs the keyboard and pedal actions within the limits", () => {
    for (let i = 0; i < 30; i++) practiceShortcut("practicePitchUp");
    expect(practice()).toMatchObject({ semitones: 24 });
    practiceShortcut("practicePitchDown");
    practiceShortcut("practiceFaster");
    expect(practice()).toMatchObject({ semitones: 23, rate: 1.05 });
    practiceShortcut("practiceReset");
    expect(practice()).toEqual({ rate: 1, semitones: 0, cents: 0 });
  });
});
