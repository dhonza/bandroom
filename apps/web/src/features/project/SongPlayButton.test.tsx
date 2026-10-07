import { MantineProvider } from "@mantine/core";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initI18n } from "../../i18n/i18n";

const togglePlay = vi.hoisted(() => vi.fn());
vi.mock("../../rehearse/controller", async () => {
  const { create } = await import("zustand");
  return {
    togglePlay,
    useRehearse: create(() => ({ open: false, songId: null as string | null, status: "idle" })),
  };
});

const { useRehearse } = await import("../../rehearse/controller");
const { SongPlayButton } = await import("./SongPlayButton");

const i18n = i18next.createInstance();

function renderButton(ready = true) {
  const onPlay = vi.fn();
  render(
    <I18nextProvider i18n={i18n}>
      <MantineProvider>
        <SongPlayButton songId="s1" title="Blue Moon" ready={ready} onPlay={onPlay} />
      </MantineProvider>
    </I18nextProvider>,
  );
  return { onPlay, button: screen.getByTestId("song-row-play") };
}

describe("SongPlayButton (SPEC §6.10, §11.2)", () => {
  beforeAll(async () => {
    await initI18n("en", i18n);
  });
  afterEach(() => {
    togglePlay.mockClear();
    act(() => {
      useRehearse.setState({ open: false, songId: null, status: "idle" });
    });
  });

  it("starts the queue at its song", async () => {
    const { onPlay, button } = renderButton();
    expect(button).toHaveAccessibleName("Play Blue Moon");
    await userEvent.click(button);
    expect(onPlay).toHaveBeenCalledWith("s1");
    expect(togglePlay).not.toHaveBeenCalled();
  });

  it("is disabled while the song has nothing to play", () => {
    const { button } = renderButton(false);
    expect(button).toBeDisabled();
  });

  it("pauses and resumes the song that is loaded", async () => {
    useRehearse.setState({ open: true, songId: "s1", status: "playing" });
    const { onPlay, button } = renderButton();
    expect(button).toHaveAccessibleName("Pause Blue Moon");
    expect(button).toHaveAttribute("data-playing", "true");
    await userEvent.click(button);
    expect(togglePlay).toHaveBeenCalledTimes(1);
    expect(onPlay).not.toHaveBeenCalled();
    act(() => {
      useRehearse.setState({ status: "stopped" });
    });
    expect(button).toHaveAccessibleName("Play Blue Moon");
    expect(button).not.toHaveAttribute("data-playing");
  });

  it("shows nothing playing for another song", () => {
    useRehearse.setState({ open: true, songId: "other", status: "playing" });
    const { button } = renderButton();
    expect(button).toHaveAccessibleName("Play Blue Moon");
    expect(button).not.toHaveAttribute("data-playing");
  });
});
