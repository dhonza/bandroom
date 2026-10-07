import type { Project } from "@bandroom/shared";
import { MantineProvider } from "@mantine/core";
import { Notifications, notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initI18n } from "../../i18n/i18n";
import { mockApi } from "../../test/mockApi";
import { ProjectSettings } from "./ProjectSettings";

const i18n = i18next.createInstance();

const base: Project = {
  id: "p1",
  name: "Demos",
  color: "red",
  songCount: 0,
  updatedAt: 1,
  archivedAt: null,
  imageHash: null,
  visibility: "full",
  access: { role: "manager", capabilities: ["view", "settings.manage"] },
  description: "Old notes",
  downloadPolicy: "all",
  ownerId: "u1",
  ownerDisplayName: "Jana",
  createdAt: 0,
};

function wrap(node: ReactNode, qc: QueryClient) {
  return (
    <I18nextProvider i18n={i18n}>
      <MantineProvider>
        <Notifications />
        <QueryClientProvider client={qc}>{node}</QueryClientProvider>
      </MantineProvider>
    </I18nextProvider>
  );
}

describe("ProjectSettings general section", () => {
  beforeAll(async () => {
    await initI18n("en", i18n);
  });
  afterEach(() => {
    notifications.clean();
    vi.unstubAllGlobals();
  });

  const nameInput = () => screen.getByLabelText(i18n.t("projects.fields.name"));
  const descInput = () => screen.getByLabelText(i18n.t("projects.fields.description"));
  const saveButton = () => screen.getByRole("button", { name: i18n.t("common.save") });

  it("archives without dropping unsaved edits", async () => {
    const bodies: unknown[] = [];
    mockApi({
      "PATCH /projects/p1": (init) => {
        bodies.push(JSON.parse(init?.body as string));
        return { body: { project: { ...base, archivedAt: 2 } } };
      },
    });
    render(wrap(<ProjectSettings project={base} />, new QueryClient()));
    await userEvent.clear(nameInput());
    await userEvent.type(nameInput(), "Live set");
    await userEvent.click(screen.getByTestId("toggle-archive"));
    await waitFor(() => {
      expect(bodies).toEqual([{ archived: true }]);
    });

    expect(await screen.findByText(i18n.t("settings.saved"))).toBeInTheDocument();
    expect(nameInput()).toHaveValue("Live set");
    expect(saveButton()).toBeEnabled();
  });

  it("takes changes saved elsewhere and keeps edits in progress", async () => {
    mockApi({});
    const qc = new QueryClient();
    const view = render(wrap(<ProjectSettings project={base} />, qc));
    // Not edited: the form follows the project.
    view.rerender(
      wrap(<ProjectSettings project={{ ...base, updatedAt: 2, description: "New notes" }} />, qc),
    );
    await waitFor(() => {
      expect(descInput()).toHaveValue("New notes");
    });
    expect(saveButton()).toBeDisabled();
    // Edited: the edit stays and can still be saved against the new baseline.
    await userEvent.type(nameInput(), "!");
    view.rerender(
      wrap(<ProjectSettings project={{ ...base, updatedAt: 3, description: "Newer" }} />, qc),
    );
    await waitFor(() => {
      expect(nameInput()).toHaveValue("Demos!");
    });
    expect(descInput()).toHaveValue("New notes");
    expect(saveButton()).toBeEnabled();
  });
});
