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
      });
      expect(onClose).toHaveBeenCalled();
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
});
