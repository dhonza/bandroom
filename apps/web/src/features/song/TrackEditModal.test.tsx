import type { ClientConfig, Track } from "@bandroom/shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Providers } from "../../app/Providers";
import { initI18n } from "../../i18n/i18n";
import { mockApi } from "../../test/mockApi";
import { TrackEditModal } from "./TrackEditModal";

const config: ClientConfig = {
  appName: "B",
  version: "1",
  basePath: "",
  defaultLocale: "en",
  logoHash: null,
};

const base: Track = {
  id: "t1",
  songId: "s1",
  name: "Bass",
  color: "orange",
  sortOrder: 0,
  instrumentTag: "",
  instrument: null,
  transpose: null,
  voiceRange: null,
  defaultGainDb: 0,
  defaultPan: 0,
  defaultMuted: false,
  versionCount: 1,
  createdBy: "u1",
  current: null,
};

async function renderModal(track: Track, props: { locked?: boolean; singleTrack?: boolean } = {}) {
  const i18n = i18next.createInstance();
  await initI18n("en", i18n);
  const onClose = vi.fn();
  render(
    <Providers config={config} i18n={i18n}>
      <TrackEditModal track={track} onClose={onClose} {...props} />
    </Providers>,
  );
  return onClose;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TrackEditModal (SPEC §30.6)", () => {
  it("shows the guessed instrument and sends only the changed playback fields", async () => {
    let sent: unknown = null;
    mockApi({
      "PATCH /tracks/t1": (init) => {
        sent = JSON.parse(init?.body as string);
        return { body: { ok: true } };
      },
    });
    const onClose = await renderModal(base);
    expect(await screen.findByDisplayValue("Automatic (Bass)")).toBeInTheDocument();
    // Voice range only for vocals.
    expect(screen.queryByTestId("track-voice-range")).not.toBeInTheDocument();
    await userEvent.click(screen.getByText("Off"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(sent).toEqual({
      name: "Bass",
      color: "orange",
      instrumentTag: "",
      transpose: false,
    });
  });

  it("shows the voice range for vocals and freezes the fields while the song is locked", async () => {
    mockApi({});
    await renderModal(
      { ...base, name: "Take", instrument: "vocals", voiceRange: "auto" },
      { locked: true },
    );
    expect(await screen.findByDisplayValue("Vocals")).toBeDisabled();
    expect(screen.getByTestId("track-voice-range")).toBeDisabled();
    expect(screen.getAllByText("Song is locked").length).toBeGreaterThan(0);
  });

  it("guesses the mix for the only unrecognised track", async () => {
    mockApi({});
    await renderModal({ ...base, name: "Take" }, { singleTrack: true });
    expect(await screen.findByDisplayValue("Automatic (Mix)")).toBeInTheDocument();
  });
});
