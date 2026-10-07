import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";
import { initI18n } from "../i18n/i18n";
import { LossyBadge } from "./LossyBadge";
import { SongLossyBadge } from "./SongLossyBadge";

const i18n = i18next.createInstance();
const media = (lossless: boolean) => ({
  durationSec: 1,
  sampleRate: 48_000,
  channels: 2,
  bitDepth: 24,
  codec: "pcm_s24le",
  lossless,
  dualMono: false,
  integratedLufs: null,
  truePeakDbtp: null,
});

const wrap = (node: React.ReactNode) =>
  render(
    <I18nextProvider i18n={i18n}>
      <MantineProvider>{node}</MantineProvider>
    </I18nextProvider>,
  );

describe("lossy badges (SPEC §26.4)", () => {
  beforeAll(async () => {
    await initI18n("en", i18n);
  });

  it("shows nothing for full quality and while processing", () => {
    wrap(
      <>
        <LossyBadge version={{ media: media(true), archived: null }} />
        <LossyBadge version={{ media: null, archived: null }} />
        <SongLossyBadge lossy="none" />
        <SongLossyBadge lossy={undefined} />
      </>,
    );
    expect(screen.queryByTestId("lossy-badge")).toBeNull();
    expect(screen.queryByTestId("song-lossy-badge")).toBeNull();
  });

  it("says why a version is lossy", () => {
    wrap(
      <>
        <LossyBadge version={{ media: media(false), archived: null }} />
        <LossyBadge
          version={{
            media: media(true),
            archived: { at: Date.UTC(2026, 9, 5), by: { id: "u", displayName: "Jana" } },
          }}
        />
      </>,
    );
    const [source, removed] = screen.getAllByTestId("lossy-badge");
    expect(source).toHaveTextContent("Lossy");
    expect(source?.getAttribute("aria-label")).toMatch(/Lossy source/);
    expect(removed?.getAttribute("data-reason")).toBe("removed");
    expect(removed?.getAttribute("aria-label")).toMatch(/Full quality removed on .*2026 by Jana/);
  });

  it("labels songs that are all or partly lossy", () => {
    wrap(
      <>
        <SongLossyBadge lossy="all" />
        <SongLossyBadge lossy="partial" />
      </>,
    );
    expect(screen.getAllByTestId("song-lossy-badge").map((b) => b.textContent)).toEqual([
      "Lossy",
      "Partly lossy",
    ]);
  });
});
