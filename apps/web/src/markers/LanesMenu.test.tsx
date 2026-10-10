import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { initI18n } from "../i18n/i18n";
import { reloadLaneVisibility, useLaneVisibility } from "../timeline/laneVisibility";
import { LanesMenu } from "./LanesMenu";

const i18n = i18next.createInstance();
beforeAll(async () => {
  await initI18n("en", i18n);
});
beforeEach(() => {
  localStorage.clear();
  reloadLaneVisibility();
});

describe("lanes menu (SPEC §11.3)", () => {
  it("toggles a lane and hides or shows them all, staying open", async () => {
    const view = render(
      <I18nextProvider i18n={i18n}>
        <MantineProvider>
          <LanesMenu />
        </MantineProvider>
      </I18nextProvider>,
    );
    fireEvent.click(screen.getByTestId("lanes-menu"));
    const comments = await screen.findByTestId("lane-toggle-comments");
    expect(comments.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("lane-toggle-sections").textContent).toContain("Sections");
    // Markers and meter changes are on the ruler (SPEC §31.4): no lane to toggle.
    expect(screen.queryByTestId("lane-toggle-markers")).toBeNull();
    fireEvent.click(comments);
    expect(useLaneVisibility.getState().hidden.comments).toBe(true);
    expect(screen.getByTestId("lane-toggle-comments").getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByTestId("lanes-hide-all"));
    expect(Object.values(useLaneVisibility.getState().hidden)).toEqual([true, true]);
    fireEvent.click(screen.getByTestId("lanes-show-all"));
    expect(Object.values(useLaneVisibility.getState().hidden)).toEqual([false, false]);
    view.unmount();
  });
});
