import type { ClientConfig, Song, Track } from "@bandroom/shared";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Providers } from "../../app/Providers";
import { routes } from "../../app/routes";
import { initI18n } from "../../i18n/i18n";
import { makeUser, mockApi } from "../../test/mockApi";

const config: ClientConfig = {
  appName: "B",
  version: "1",
  basePath: "",
  defaultLocale: "en",
  logoHash: null,
};

const song: Song = {
  id: "s1",
  projectId: "p1",
  title: "Demo",
  subtitle: "",
  key: "",
  sortOrder: 0,
  updatedAt: 0,
  notes: "",
  downloadPolicy: "inherit",
  locked: null,
  createdAt: 0,
  project: { id: "p1", name: "Album", color: "teal", imageHash: null },
  access: {
    role: "contributor",
    capabilities: [
      "view",
      "stream",
      "download",
      "comment",
      "upload",
      "record",
      "annotate.own",
      "edit.own",
      "delete.own",
    ],
  },
};

const track: Track = {
  id: "t1",
  songId: "s1",
  name: "Bass",
  color: "blue",
  sortOrder: 0,
  instrumentTag: "bass",
  defaultGainDb: 0,
  defaultPan: 0,
  defaultMuted: false,
  versionCount: 2,
  createdBy: "u1",
  current: {
    id: "v2",
    number: 2,
    label: "",
    notes: "",
    offsetSamples: 0,
    gainDb: 0,
    source: "upload",
    createdAt: 0,
    uploadedBy: "u1",
    uploaderName: "Jana",
    originalFilename: "bass.wav",
    sizeBytes: 3 * 1024 * 1024,
    status: "ready",
    error: null,
    archived: null,
    progress: null,
    media: {
      durationSec: 187,
      sampleRate: 48000,
      channels: 1,
      bitDepth: 24,
      codec: "pcm_s24le",
      lossless: true,
      dualMono: true,
      integratedLufs: -14.2,
      truePeakDbtp: -1,
    },
    variants: {
      opus: {
        hash: "a".repeat(64),
        bitrate: 64,
        channels: 1,
        preSkip: 312,
        durationSamples48k: 187 * 48000,
      },
      opusLow: null,
      flac: {
        hash: "b".repeat(64),
        sampleRate: 48000,
        bitDepth: 24,
        channels: 1,
        durationSamples: 187 * 48000,
        nearLossless: false,
      },
      peaks: { hash: "c".repeat(64), overview: Array.from({ length: 1024 }, (_, i) => i % 127) },
      seekIndex: { opus: null, opusLow: null, flac: null },
    },
    downloads: ["flac", "wav", "opus"],
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("song page tracks", () => {
  it("renders tracks with version, media details and badges (and does not loop)", async () => {
    mockApi({
      "GET /auth/session": () => ({ body: { user: makeUser({ id: "u1", globalRole: "member" }) } }),
      "GET /songs/s1": () => ({ body: { song } }),
      "GET /songs/s1/tracks": () => ({ body: { tracks: [track] } }),
    });
    const i18n = i18next.createInstance();
    await initI18n("en", i18n);
    render(
      <Providers config={config} i18n={i18n}>
        <RouterProvider router={createMemoryRouter(routes, { initialEntries: ["/songs/s1"] })} />
      </Providers>,
    );
    expect(await screen.findByRole("heading", { level: 2, name: "Demo" })).toBeInTheDocument();
    const row = await screen.findByTestId("track-row");
    expect(within(row).getByText("Bass")).toBeInTheDocument();
    expect(within(row).getByTestId("version-button")).toHaveTextContent("v2 / 2");
    expect(
      within(row).getByText("3:07 · FLAC 24-bit 48 kHz + Opus 64 kbps mono · 3 MB · -14.2 LUFS"),
    ).toBeInTheDocument();
    expect(within(row).getByText("dual mono")).toBeInTheDocument();
    expect(screen.getByTestId("track-dropzone")).toBeInTheDocument();
  });
});

describe("song page sizes (SPEC §28.6)", () => {
  it("shows the song's, the track's and the version's stored sizes", async () => {
    const sized: Track = {
      ...track,
      bytes: 5 * 1024 * 1024,
      current: track.current && { ...track.current, storedBytes: 2 * 1024 * 1024 },
    };
    mockApi({
      "GET /auth/session": () => ({ body: { user: makeUser({ id: "u1", globalRole: "member" }) } }),
      "GET /songs/s1": () => ({ body: { song: { ...song, bytes: 7 * 1024 * 1024 } } }),
      "GET /songs/s1/tracks": () => ({ body: { tracks: [sized] } }),
    });
    const i18n = i18next.createInstance();
    await initI18n("en", i18n);
    render(
      <Providers config={config} i18n={i18n}>
        <RouterProvider router={createMemoryRouter(routes, { initialEntries: ["/songs/s1"] })} />
      </Providers>,
    );
    expect(await screen.findByTestId("song-meta")).toHaveTextContent("7 MB");
    const row = await screen.findByTestId("track-row");
    expect(
      within(row).getByText(
        "3:07 · FLAC 24-bit 48 kHz + Opus 64 kbps mono · 2 MB · all versions 5 MB · -14.2 LUFS",
      ),
    ).toBeInTheDocument();
  });
});

describe("song page track reorder (SPEC §28.5)", () => {
  const drums: Track = { ...track, id: "t2", name: "Drums", sortOrder: 1 };
  const renderAs = async (caps: Song["access"]["capabilities"], role: Song["access"]["role"]) => {
    mockApi({
      "GET /auth/session": () => ({ body: { user: makeUser({ id: "u1", globalRole: "member" }) } }),
      "GET /songs/s1": () => ({
        body: { song: { ...song, access: { role, capabilities: caps } } },
      }),
      "GET /songs/s1/tracks": () => ({ body: { tracks: [track, drums] } }),
    });
    const i18n = i18next.createInstance();
    await initI18n("en", i18n);
    render(
      <Providers config={config} i18n={i18n}>
        <RouterProvider router={createMemoryRouter(routes, { initialEntries: ["/songs/s1"] })} />
      </Providers>,
    );
    await screen.findAllByTestId("track-row");
  };

  it("shows a drag handle per track for editors, none in selection mode", async () => {
    await renderAs([...song.access.capabilities, "edit.any", "delete.any"], "editor");
    expect(screen.getByRole("button", { name: "Reorder Bass" })).toBeInTheDocument();
    expect(screen.getAllByTestId("track-drag-handle")).toHaveLength(2);
    await userEvent.click(screen.getByTestId("tracks-select"));
    await waitFor(() => {
      expect(screen.queryAllByTestId("track-drag-handle")).toHaveLength(0);
    });
  });

  it("has no drag handle without edit.any", async () => {
    await renderAs(song.access.capabilities, "contributor");
    expect(screen.queryAllByTestId("track-drag-handle")).toHaveLength(0);
  });
});

describe("song page delete", () => {
  it("leaves for the project without refetching the deleted song", async () => {
    let songGets = 0;
    let deleted = false;
    mockApi({
      "GET /auth/session": () => ({ body: { user: makeUser({ id: "u1", globalRole: "member" }) } }),
      "GET /songs/s1": () => {
        songGets++;
        return deleted
          ? { status: 404, body: { code: "NOT_FOUND", message: "gone" } }
          : {
              body: {
                song: {
                  ...song,
                  access: { role: "manager", capabilities: ["view", "song.delete"] },
                },
              },
            };
      },
      "GET /songs/s1/tracks": () => ({ body: { tracks: [] } }),
      "DELETE /songs/s1": () => {
        deleted = true;
        return { body: { ok: true } };
      },
    });
    const i18n = i18next.createInstance();
    await initI18n("en", i18n);
    const router = createMemoryRouter(routes, { initialEntries: ["/songs/s1"] });
    render(
      <Providers config={config} i18n={i18n}>
        <RouterProvider router={router} />
      </Providers>,
    );
    await userEvent.click(await screen.findByTestId("delete-song"));
    await userEvent.type(await screen.findByTestId("confirm-name"), "Demo");
    await userEvent.click(screen.getByTestId("confirm-delete"));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/projects/p1");
    });
    const gets = songGets;
    // Give a stray refetch the chance to happen.
    await new Promise((r) => setTimeout(r, 50));
    expect(songGets).toBe(gets);
    expect(songGets).toBe(1);
  });
});
