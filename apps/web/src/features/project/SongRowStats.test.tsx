import type { SongSummary } from "@bandroom/shared";
import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";
import { initI18n } from "../../i18n/i18n";
import { songChannelsLabel, SongRowStats } from "./SongRowStats";

const en = i18next.createInstance();
const cs = i18next.createInstance();

const song = (extra: Partial<SongSummary>): SongSummary => ({
  id: "s1",
  projectId: "p1",
  title: "Blue Moon",
  subtitle: "",
  key: "",
  sortOrder: 0,
  updatedAt: 0,
  access: { role: "manager", capabilities: [] },
  ...extra,
});

function renderStats(s: SongSummary, withBytes = true) {
  return render(
    <I18nextProvider i18n={en}>
      <MantineProvider>
        <SongRowStats song={s} withBytes={withBytes} />
      </MantineProvider>
    </I18nextProvider>,
  );
}

describe("song row length and mono/stereo (SPEC §11.2)", () => {
  beforeAll(async () => {
    await initI18n("en", en);
    await initI18n("cs", cs);
  });

  it("shows length · mark · size, stereo when any track plays stereo", () => {
    renderStats(
      song({ durationSec: 252.4, channels: { stereo: 4, mono: 3 }, bytes: 38 * 1024 * 1024 }),
    );
    expect(screen.getByTestId("song-length")).toHaveTextContent("4:12");
    const mark = screen.getByTestId("song-channels");
    expect(mark).toHaveAttribute("data-channels", "stereo");
    expect(mark).toHaveAccessibleName("7 tracks: 4 stereo, 3 mono");
    expect(screen.getByTestId("song-bytes")).toHaveTextContent("38 MB");
    expect(screen.getByTestId("song-row-stats")).toHaveTextContent(/^4:12·.*·38 MB$/);
  });

  it("is mono only when every track is mono, and leaves the size to the title line when narrow", () => {
    renderStats(song({ durationSec: 61, channels: { stereo: 0, mono: 1 }, bytes: 5 }), false);
    expect(screen.getByTestId("song-channels")).toHaveAttribute("data-channels", "mono");
    expect(screen.getByTestId("song-channels")).toHaveAccessibleName("1 track: 1 mono");
    expect(screen.getByTestId("song-length")).toHaveTextContent("1:01");
    expect(screen.queryByTestId("song-bytes")).toBeNull();
  });

  it("shows no length or mark without ready audio", () => {
    const { container } = renderStats(song({ bytes: 0 }));
    expect(container.querySelector("[data-testid='song-row-stats']")).toBeNull();
    renderStats(song({ bytes: 2048 }));
    expect(screen.queryByTestId("song-length")).toBeNull();
    expect(screen.queryByTestId("song-channels")).toBeNull();
    expect(screen.getByTestId("song-bytes")).toBeInTheDocument();
  });

  it("words the counts in Czech with plurals", () => {
    const t = cs.getFixedT("cs");
    expect(songChannelsLabel(t, { stereo: 4, mono: 3 })).toBe("7 stop: 4 stereo, 3 mono");
    expect(songChannelsLabel(t, { stereo: 2, mono: 0 })).toBe("2 stopy: 2 stereo");
    expect(songChannelsLabel(t, { stereo: 0, mono: 1 })).toBe("1 stopa: 1 mono");
  });
});
