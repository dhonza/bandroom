import type { Comment, Marker, Song } from "@bandroom/shared";
import { MantineProvider } from "@mantine/core";
import { Notifications, notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentUserContext } from "../auth/session";
import { initI18n } from "../i18n/i18n";
import { makeUser, mockApi } from "../test/mockApi";
import { resetTimelineUiForTests, setItemsOpen, useTimelineUi } from "./store";
import { TimelineItemsDialog } from "./TimelineItemsDialog";

const i18n = i18next.createInstance();

const marker = (over: Partial<Marker>): Marker => ({
  id: "m",
  songId: "s1",
  type: "marker",
  name: "M",
  color: "yellow",
  note: "",
  startSec: 0,
  endSec: null,
  anchor: "time",
  startBeat: null,
  endBeat: null,
  lane: 0,
  createdBy: "u1",
  createdByName: "Jana",
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const ID = (n: number) => `0192f0c4-0000-7000-8000-00000000000${n}`;
const MARKERS = [
  marker({ id: ID(1), name: "Intro", startSec: 0 }),
  marker({ id: ID(2), name: "Verse", startSec: 12.5 }),
  marker({ id: ID(3), type: "section", name: "Chorus", startSec: 30, endSec: 45, color: "red" }),
  marker({ id: ID(4), name: "Theirs", startSec: 50, createdBy: "u2" }),
];

const comment: Comment = {
  id: "c1",
  songId: "s1",
  trackId: null,
  parentId: null,
  author: { userId: "u1", name: "Jana", username: "jana", kind: "user" },
  body: "Bass is late",
  startSec: 10,
  endSec: 12,
  context: { trackVersions: {}, tempoRev: null },
  source: "app",
  resolvedAt: null,
  resolvedByName: null,
  createdAt: 1,
  editedAt: null,
  deleted: false,
  reactions: [],
  mentions: [],
  replies: [],
};

function songWith(role: "contributor" | "viewer"): Song {
  return {
    id: "s1",
    locked: null,
    access: {
      role,
      capabilities: role === "viewer" ? ["view"] : ["view", "comment", "annotate.own"],
    },
  } as unknown as Song;
}

function renderDialog(role: "contributor" | "viewer" = "contributor") {
  render(
    <I18nextProvider i18n={i18n}>
      <MantineProvider>
        <Notifications />
        <QueryClientProvider client={new QueryClient()}>
          <CurrentUserContext.Provider value={makeUser({ id: "u1", globalRole: "member" })}>
            <TimelineItemsDialog song={songWith(role)} />
          </CurrentUserContext.Provider>
        </QueryClientProvider>
      </MantineProvider>
    </I18nextProvider>,
  );
}

const bodyOf = (fetch: ReturnType<typeof vi.fn>, key: string): unknown => {
  const call = fetch.mock.calls.find(([url, init]) => {
    const u = typeof url === "string" ? url : String(url);
    return `${(init as RequestInit | undefined)?.method ?? "GET"} ${u}`.includes(key);
  });
  return JSON.parse(((call?.[1] as RequestInit | undefined)?.body as string | undefined) ?? "null");
};

describe("TimelineItemsDialog", () => {
  beforeAll(async () => {
    await initI18n("en", i18n);
  });
  beforeEach(() => {
    resetTimelineUiForTests();
    useTimelineUi.setState({ markers: MARKERS });
    setItemsOpen(true);
  });
  afterEach(() => {
    notifications.clean();
    vi.unstubAllGlobals();
  });

  it("lists items by time and renames on blur", { timeout: 20_000 }, async () => {
    const fetch = mockApi({
      [`PATCH /markers/${ID(2)}`]: () => ({
        body: { marker: { ...MARKERS[1], name: "Verse 1" } },
      }),
    });
    renderDialog();
    const rows = await screen.findAllByTestId("items-row");
    expect(rows.map((r) => within(r).getByTestId("items-name"))).toHaveLength(4);
    expect(rows.map((r) => r.getAttribute("data-type"))).toEqual([
      "marker",
      "marker",
      "section",
      "marker",
    ]);
    // Only sections have an end; someone else's marker is read-only for a contributor.
    expect(within(rows[2] as HTMLElement).getByTestId("items-end")).toHaveValue("0:45.000");
    expect(within(rows[0] as HTMLElement).queryByTestId("items-end")).toBeNull();
    expect(within(rows[3] as HTMLElement).getByTestId("items-name")).toBeDisabled();
    const name = within(rows[1] as HTMLElement).getByTestId("items-name");
    await userEvent.clear(name);
    await userEvent.type(name, "Verse 1{Enter}");
    await waitFor(() => {
      expect(bodyOf(fetch, `PATCH /api/v1/markers/${ID(2)}`)).toEqual({ name: "Verse 1" });
    });
  });

  it("refuses a start after a section's end", { timeout: 20_000 }, async () => {
    const fetch = mockApi({});
    renderDialog();
    const rows = await screen.findAllByTestId("items-row");
    const start = within(rows[2] as HTMLElement).getByTestId("items-start");
    await userEvent.clear(start);
    await userEvent.type(start, "0:50{Enter}");
    expect(start).toHaveAttribute("aria-invalid", "true");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("converts the selected markers with undo", { timeout: 20_000 }, async () => {
    const created = marker({
      id: ID(9),
      type: "section",
      name: "Intro",
      startSec: 0,
      endSec: 12.5,
    });
    const fetch = mockApi({
      "POST /songs/s1/markers/convert": () => ({
        body: { markers: [created], deletedIds: [ID(1)], skippedIds: [], timelineRev: 3 },
      }),
      [`DELETE /markers/${ID(9)}`]: () => ({ body: { ok: true } }),
      [`POST /markers/${ID(1)}/restore`]: () => ({ body: { marker: MARKERS[0] } }),
    });
    renderDialog();
    await userEvent.click(await screen.findByRole("checkbox", { name: "Select Intro" }));
    expect(screen.getByTestId("items-selected-count")).toHaveTextContent("Selected: 1");
    expect(screen.getByTestId("items-to-markers")).toBeDisabled();
    await userEvent.click(screen.getByTestId("items-to-sections"));
    await waitFor(() => {
      expect(bodyOf(fetch, "POST /api/v1/songs/s1/markers/convert")).toMatchObject({
        ids: [ID(1)],
        to: "section",
      });
    });
    await userEvent.click(await screen.findByTestId("marker-undo"));
    await waitFor(() => {
      expect(fetch.mock.calls.map(([u, i]) => `${(i as RequestInit).method} ${String(u)}`)).toEqual(
        expect.arrayContaining([
          expect.stringContaining(`DELETE /api/v1/markers/${ID(9)}`),
          expect.stringContaining(`POST /api/v1/markers/${ID(1)}/restore`),
        ]),
      );
    });
  });

  it("is read-only for viewers", { timeout: 20_000 }, async () => {
    mockApi({});
    renderDialog("viewer");
    const rows = await screen.findAllByTestId("items-row");
    for (const r of rows) {
      expect(within(r).getByTestId("items-name")).toBeDisabled();
      expect(within(r).getByTestId("items-delete")).toBeDisabled();
    }
    expect(screen.getByTestId("items-select-all")).toBeDisabled();
  });

  it("moves and edits comments", { timeout: 20_000 }, async () => {
    const fetch = mockApi({
      "GET /songs/s1/comments": () => ({ body: { comments: [comment], nextCursor: null } }),
      "PATCH /comments/c1": () => ({ body: { comment: { ...comment, startSec: 20, endSec: 22 } } }),
    });
    renderDialog();
    await userEvent.click(screen.getByTestId("items-tab-comments"));
    const start = await screen.findByTestId("items-comment-start");
    expect(start).toHaveValue("0:10.000");
    await userEvent.clear(start);
    await userEvent.type(start, "0:20{Enter}");
    // A range keeps its length when its start moves.
    await waitFor(() => {
      expect(bodyOf(fetch, "PATCH /api/v1/comments/c1")).toEqual({ startSec: 20, endSec: 22 });
    });
    expect(screen.getByTestId("items-comment-body")).toHaveValue("Bass is late");
  });
});
