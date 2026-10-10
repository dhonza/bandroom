import type { Marker, Song } from "@bandroom/shared";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CurrentUserContext } from "../auth/session";
import { initI18n } from "../i18n/i18n";
import { makeUser } from "../test/mockApi";
import { setCoarsePointer } from "../test/setup";
import { setSectionPills, useSectionPills } from "./pillsStore";
import { SectionPills } from "./SectionPills";
import { resetTimelineUiForTests, useTimelineUi } from "./store";

const i18n = i18next.createInstance();

const section = (id: string, name: string, startSec: number, endSec: number): Marker => ({
  id,
  songId: "s1",
  type: "section",
  name,
  color: "red",
  note: "",
  startSec,
  endSec,
  anchor: "time",
  startBeat: null,
  endBeat: null,
  lane: 0,
  createdBy: "u1",
  createdByName: "Jana",
  createdAt: 0,
  updatedAt: 0,
});

const song = {
  id: "s1",
  locked: null,
  editing: null,
  access: { role: "contributor", capabilities: ["view", "annotate.own"] },
} as unknown as Song;

function renderPills(userId = "u1") {
  return render(
    <I18nextProvider i18n={i18n}>
      <MantineProvider>
        <QueryClientProvider client={new QueryClient()}>
          <CurrentUserContext.Provider value={makeUser({ id: userId, globalRole: "member" })}>
            <SectionPills song={song} />
          </CurrentUserContext.Provider>
        </QueryClientProvider>
      </MantineProvider>
    </I18nextProvider>,
  );
}

describe("SectionPills (SPEC §31.3)", () => {
  beforeAll(async () => {
    await initI18n("en", i18n);
  });
  beforeEach(() => {
    resetTimelineUiForTests();
    useSectionPills.setState({ byUser: {} });
    useTimelineUi.setState({
      markers: [section("a", "Verse", 0, 10), section("b", "Chorus", 10, 20)],
    });
  });

  it("are off by default and per user", () => {
    renderPills();
    expect(screen.queryByTestId("section-pills")).toBeNull();
    setSectionPills("u2", true);
    expect(screen.queryByTestId("section-pills")).toBeNull();
  });

  it("tap seeks, double tap loops; 22 px with a mouse; ⌃ hides them", () => {
    setSectionPills("u1", true);
    renderPills();
    const pills = screen.getAllByTestId("section-chip");
    expect(pills.map((p) => p.textContent)).toEqual(["Verse", "Chorus"]);
    expect(pills[1]).toHaveStyle({ height: "22px" });
    expect(pills[1]).toHaveAttribute("data-touch-exempt");
    fireEvent.doubleClick(pills[1] as HTMLElement);
    expect(useTimelineUi.getState().loopOn).toBe(true);
    expect(useTimelineUi.getState().selection).toEqual({ start: 10, end: 20 });
    expect(screen.getAllByTestId("section-chip")[1]).toHaveAttribute("data-looped", "true");
    fireEvent.click(screen.getByTestId("section-pills-hide"));
    expect(screen.queryByTestId("section-pills")).toBeNull();
  });

  it("are 34 px on touch screens", () => {
    setCoarsePointer(true);
    setSectionPills("u1", true);
    renderPills();
    expect(screen.getAllByTestId("section-chip")[0]).toHaveStyle({ height: "34px" });
    expect(screen.getByTestId("pills-add-section")).toBeDisabled();
  });
});
