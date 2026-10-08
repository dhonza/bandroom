import { MantineProvider } from "@mantine/core";
import { Notifications, notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initI18n } from "../i18n/i18n";
import { mockApi } from "../test/mockApi";
import { BounceModal } from "./BounceModal";
import { setSongTempo, useTempoUi } from "../tempo/store";
import { useRehearse, type RehearseState } from "./controller";

const i18n = i18next.createInstance();
const song = { id: "s1", title: "Blue Moon" };
const mix = {
  tracks: {
    t1: { gainDb: -6, pan: -0.5, mute: false, solo: false, listenedVersionId: null },
    t2: { gainDb: 0, pan: 0, mute: true, solo: false, listenedVersionId: null },
  },
};

function renderModal(onClose = vi.fn()) {
  const router = createMemoryRouter(
    [
      {
        path: "/songs/:id",
        element: <BounceModal song={song} opened onClose={onClose} fullScreen={false} />,
      },
    ],
    { initialEntries: ["/songs/s1"] },
  );
  render(
    <I18nextProvider i18n={i18n}>
      <MantineProvider>
        <Notifications />
        <QueryClientProvider client={new QueryClient()}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </MantineProvider>
    </I18nextProvider>,
  );
  return { router, onClose };
}

describe("BounceModal (SPEC §5.5)", () => {
  beforeAll(async () => {
    await initI18n("en", i18n);
    useRehearse.setState({
      mix,
      tracks: [
        { track: { id: "t1" }, version: { id: "v1" } },
        { track: { id: "t2" }, version: { id: "v2b" } },
      ] as unknown as RehearseState["tracks"],
    });
  });
  afterEach(() => {
    notifications.clean();
    vi.unstubAllGlobals();
  });

  it(
    "sends the mix and the playing versions, then links to the new song",
    { timeout: 20_000 },
    async () => {
      const fetch = mockApi({
        "POST /songs/s1/bounce": () => ({
          body: {
            song: {
              id: "s2",
              projectId: "p1",
              title: "Blue Moon (bounce)",
              subtitle: "",
              key: "",
              sortOrder: 1,
              updatedAt: 0,
              access: { role: "editor", capabilities: [] },
            },
            trackId: "t9",
            versionId: "v9",
          },
        }),
      });
      const { router, onClose } = renderModal();
      expect(await screen.findByTestId("bounce-title")).toHaveValue("Blue Moon (bounce)");
      await userEvent.click(screen.getByTestId("bounce-submit"));
      expect(await screen.findByTestId("bounce-open")).toHaveTextContent("Blue Moon (bounce)");
      const init = fetch.mock.calls[0]?.[1] as RequestInit;
      expect(JSON.parse(init.body as string)).toEqual({
        title: "Blue Moon (bounce)",
        mix,
        versions: { t1: "v1", t2: "v2b" },
        copyTempo: true,
        copyMarkers: true,
        includeClick: false,
        applyPractice: false,
      });
      expect(onClose).toHaveBeenCalled();
      // No practice setting: no switch.
      expect(screen.queryByTestId("bounce-applyPractice")).toBeNull();
      await userEvent.click(screen.getByTestId("bounce-open"));
      expect(router.state.location.pathname).toBe("/songs/s2");
    },
  );

  it("shows the server's reason and needs a title", { timeout: 20_000 }, async () => {
    mockApi({
      "POST /songs/s1/bounce": () => ({
        status: 400,
        body: { code: "BOUNCE_SILENT", message: "silent" },
      }),
    });
    renderModal();
    const title = await screen.findByTestId("bounce-title");
    await userEvent.clear(title);
    expect(screen.getByTestId("bounce-submit")).toBeDisabled();
    await userEvent.type(title, "Take");
    await userEvent.click(screen.getByTestId("bounce-submit"));
    expect(await screen.findByText(i18n.t("errors.BOUNCE_SILENT"))).toBeInTheDocument();
  });

  it(
    "copies tempo and markers by default; the click needs a tempo map",
    { timeout: 20_000 },
    async () => {
      const fetch = mockApi({
        "POST /songs/s1/bounce": () => ({ status: 400, body: { code: "BOUNCE_SILENT" } }),
      });
      useTempoUi.setState({ songId: null, tempo: null, grid: null, preview: false });
      renderModal();
      const click = await screen.findByTestId("bounce-includeClick");
      expect(screen.getByTestId("bounce-copyTempo")).toBeChecked();
      expect(screen.getByTestId("bounce-copyMarkers")).toBeChecked();
      expect(click).not.toBeChecked();
      expect(click).toBeDisabled();
      expect(screen.getByText(i18n.t("click.noTempo"))).toBeInTheDocument();

      setSongTempo("s1", {
        map: { segments: [{ startBeat: 0, bpm: 120, meter: { num: 4, den: 4 }, barIndex: 0 }] },
        bar1OffsetSec: 0,
        source: "manual",
        midiFileName: null,
        revisionId: "r1",
        updatedByName: null,
        updatedAt: 0,
      });
      await vi.waitFor(() => {
        expect(screen.getByTestId("bounce-includeClick")).toBeEnabled();
      });
      await userEvent.click(screen.getByTestId("bounce-includeClick"));
      await userEvent.click(screen.getByTestId("bounce-copyMarkers"));
      await userEvent.click(screen.getByTestId("bounce-submit"));
      await vi.waitFor(() => {
        expect(fetch).toHaveBeenCalled();
      });
      const init = fetch.mock.calls[0]?.[1] as RequestInit;
      expect(JSON.parse(init.body as string)).toMatchObject({
        copyTempo: true,
        copyMarkers: false,
        includeClick: true,
      });
    },
  );

  it(
    "applies a practice setting by default, with a suffixed title that follows the switch",
    { timeout: 20_000 },
    async () => {
      const fetch = mockApi({
        "POST /songs/s1/bounce": () => ({ status: 400, body: { code: "BOUNCE_SILENT" } }),
      });
      const practiceMix = { ...mix, practice: { rate: 0.85, semitones: -2 } };
      const before = useRehearse.getState();
      useRehearse.setState({
        mix: practiceMix,
        tracks: [
          { track: { id: "t1", name: "Keys", transpose: null }, version: { id: "v1" } },
          { track: { id: "t2", name: "Drums", transpose: null }, version: { id: "v2b" } },
        ] as unknown as RehearseState["tracks"],
      });
      try {
        renderModal();
        const title = await screen.findByTestId("bounce-title");
        expect(title).toHaveValue("Blue Moon (85 %, −2 st)");
        const apply = screen.getByTestId("bounce-applyPractice");
        expect(apply).toBeChecked();
        expect(
          screen.getByText(i18n.t("bounce.applyPractice", { practice: "85 %, −2 st" })),
        ).toBeInTheDocument();
        expect(screen.getByTestId("bounce-pitchLocked")).toHaveTextContent("Drums");
        expect(screen.getByTestId("bounce-pitchLocked")).not.toHaveTextContent("Keys");

        await userEvent.click(apply);
        expect(title).toHaveValue("Blue Moon (bounce)");
        expect(screen.queryByTestId("bounce-pitchLocked")).toBeNull();
        await userEvent.click(apply);
        expect(title).toHaveValue("Blue Moon (85 %, −2 st)");
        // Once edited, the title stays.
        await userEvent.type(title, "!");
        await userEvent.click(apply);
        expect(title).toHaveValue("Blue Moon (85 %, −2 st)!");
        await userEvent.click(apply);

        await userEvent.click(screen.getByTestId("bounce-submit"));
        await vi.waitFor(() => {
          expect(fetch).toHaveBeenCalled();
        });
        const init = fetch.mock.calls[0]?.[1] as RequestInit;
        expect(JSON.parse(init.body as string)).toMatchObject({
          title: "Blue Moon (85 %, −2 st)!",
          mix: practiceMix,
          applyPractice: true,
        });
      } finally {
        useRehearse.setState({ mix: before.mix, tracks: before.tracks });
      }
    },
  );
});
