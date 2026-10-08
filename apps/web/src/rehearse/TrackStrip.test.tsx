import type { Song, Track, TrackVersion } from "@bandroom/shared";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { initI18n } from "../i18n/i18n";
import { mockApi } from "../test/mockApi";
import { useRehearse } from "./controller";
import type { PlayableTrack } from "./model";
import { TrackStrip } from "./TrackStrip";

const i18n = i18next.createInstance();

const song = {
  id: "s1",
  access: { role: "viewer", capabilities: ["view", "stream"] },
} as unknown as Song;

function playable(channels: number, dualMono: boolean): PlayableTrack {
  const version = {
    id: "v3",
    number: 3,
    gainDb: 0,
    media: { dualMono, channels: dualMono ? 1 : channels },
  } as unknown as TrackVersion;
  const track = {
    id: "t1",
    name: "Bass",
    color: "blue",
    createdBy: "u1",
    current: version,
  } as unknown as Track;
  return {
    track,
    version,
    chosen: {
      quality: "high",
      variant: {
        kind: "opus",
        hash: "a",
        url: "",
        seekIndexUrl: null,
        channels,
        dualMono,
        preSkip: 0,
        totalFrames: 0,
        sampleRate: 48_000,
      },
    },
  };
}

function renderStrip(p: PlayableTrack, height: number, compact = false) {
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={new QueryClient()}>
        <MantineProvider>
          <div style={{ height }}>
            <TrackStrip playable={p} song={song} height={height} compact={compact} />
          </div>
        </MantineProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

describe("TrackStrip mono/stereo mark", () => {
  beforeAll(async () => {
    await initI18n("en", i18n);
  });
  beforeEach(() => {
    mockApi({});
    useRehearse.setState({
      songId: "s1",
      previewSongId: null,
      mix: { tracks: { t1: { gainDb: 0, pan: 0, mute: false, solo: false } } },
    });
  });

  const cases = [
    { name: "full", height: 120, compact: false },
    { name: "two", height: 80, compact: false },
    { name: "one", height: 50, compact: false },
    { name: "two", height: 80, compact: true },
    { name: "one", height: 50, compact: true },
  ] as const;

  for (const c of cases) {
    it(`shows the mark in the ${c.name} tier${c.compact ? " (phone)" : ""}`, () => {
      renderStrip(playable(2, false), c.height, c.compact);
      expect(screen.getByTestId("track-strip")).toHaveAttribute("data-tier", c.name);
      const mark = screen.getByTestId("track-channels");
      expect(mark).toHaveAttribute("data-channels", "stereo");
      expect(mark).toHaveAttribute("aria-label", "Stereo");
    });
  }

  it("mono, and dual mono plays mono", async () => {
    renderStrip(playable(1, false), 120);
    expect(screen.getByRole("img", { name: "Mono" })).toHaveAttribute("data-channels", "mono");
    await userEvent.hover(screen.getByTestId("track-channels"));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Mono");
  });

  it("dual mono: the tooltip names the source", async () => {
    renderStrip(playable(1, true), 120);
    const mark = screen.getByRole("img", { name: "Mono (dual mono source)" });
    expect(mark).toHaveAttribute("data-channels", "mono");
    await userEvent.hover(mark);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Mono (dual mono source)");
  });

  it("the settings popover spells it out on short lanes", async () => {
    renderStrip(playable(1, true), 80);
    await userEvent.click(screen.getByTestId("track-settings"));
    const panel = await screen.findByTestId("track-settings-panel");
    expect(within(panel).getByTestId("track-channels-text")).toHaveTextContent(
      "Mono (dual mono source)",
    );
  });
});

describe("TrackStrip peak meter", () => {
  beforeAll(async () => {
    await initI18n("en", i18n);
  });
  beforeEach(() => {
    mockApi({});
    useRehearse.setState({
      songId: "s1",
      previewSongId: null,
      mix: { tracks: { t1: { gainDb: 0, pan: 0, mute: false, solo: false } } },
    });
  });

  const cases = [
    { tier: "full", height: 120, compact: false, orientation: "horizontal" },
    { tier: "two", height: 80, compact: false, orientation: "vertical" },
    { tier: "one", height: 50, compact: false, orientation: "vertical" },
    { tier: "two", height: 80, compact: true, orientation: "vertical" },
    { tier: "one", height: 50, compact: true, orientation: "vertical" },
  ] as const;

  for (const c of cases) {
    it(`is in the ${c.tier} tier${c.compact ? " (phone)" : ""}, ${c.orientation}`, () => {
      renderStrip(playable(2, false), c.height, c.compact);
      expect(screen.getByTestId("track-strip")).toHaveAttribute("data-tier", c.tier);
      const meters = screen.getAllByRole("meter", { name: "Level of Bass" });
      expect(meters).toHaveLength(1);
      expect(meters[0]).toHaveAttribute("data-orientation", c.orientation);
      // Silent until the engine reports.
      const bar = within(meters[0] as HTMLElement).getByTestId("track-meter-bar");
      expect(c.orientation === "vertical" ? bar.style.height : bar.style.width).toMatch(/^0(px)?$/);
    });
  }
});
