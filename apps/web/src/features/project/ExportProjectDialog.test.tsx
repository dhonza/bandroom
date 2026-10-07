import type { Project } from "@bandroom/shared";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initI18n } from "../../i18n/i18n";
import { mockApi } from "../../test/mockApi";
import { ExportProjectDialog } from "./ExportProjectDialog";

const i18n = i18next.createInstance();

const project: Project = {
  id: "p1",
  name: "Demos",
  color: "red",
  songCount: 5,
  updatedAt: 1,
  archivedAt: null,
  imageHash: null,
  visibility: "full",
  access: { role: "manager", capabilities: ["view", "download"] },
  description: "",
  downloadPolicy: "all",
  ownerId: "u1",
  ownerDisplayName: "Jana",
  createdAt: 0,
};

describe("ExportProjectDialog (SPEC §28.7)", () => {
  beforeAll(async () => {
    await initI18n("en", i18n);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("summarises the archive, warns about fallbacks and links the FLAC download", async () => {
    mockApi({
      "GET /projects/p1/export/preview": () => ({
        body: {
          files: 12,
          songs: 5,
          skippedSongs: 1,
          documents: 2,
          opusFallbacks: 3,
          originalFallbacks: 0,
          bytes: 1.9 * 1024 ** 3,
        },
      }),
    });
    render(
      <I18nextProvider i18n={i18n}>
        <MantineProvider>
          <QueryClientProvider client={new QueryClient()}>
            <ExportProjectDialog project={project} onClose={() => undefined} />
          </QueryClientProvider>
        </MantineProvider>
      </I18nextProvider>,
    );
    expect(await screen.findByTestId("export-summary")).toHaveTextContent(
      "12 files in 5 songs · 1.9 GB",
    );
    expect(screen.getByTestId("export-skipped")).toHaveTextContent("1 song is left out");
    expect(screen.getByTestId("export-opus-fallback")).toHaveTextContent("3 tracks");
    expect(screen.queryByTestId("export-original-fallback")).toBeNull();
    expect(screen.getByTestId("export-download")).toHaveAttribute(
      "href",
      "/api/v1/projects/p1/export/download?format=flac",
    );
  });
});
