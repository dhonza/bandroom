import type { Project, SongSummary } from "@bandroom/shared";
import { MantineProvider } from "@mantine/core";
import { Notifications, notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { strToU8, zipSync } from "fflate";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n } from "../../i18n/i18n";
import { mockApi } from "../../test/mockApi";
import { startUpload } from "../../upload/startUpload";
import type * as StartUploadModule from "../../upload/startUpload";
import { useUploads, type UploadItem } from "../../upload/uploadStore";
import { FolderDrop } from "./FolderDrop";

vi.mock("../../upload/startUpload", async (importOriginal) => ({
  ...(await importOriginal<typeof StartUploadModule>()),
  startUpload: vi.fn(),
}));

const project = { id: "p1" } as Project;
const otherProject = "p2";

const song: SongSummary = {
  id: "s1",
  projectId: "p1",
  title: "take1",
  subtitle: "",
  key: "",
  sortOrder: 0,
  updatedAt: 0,
  access: { role: "editor", capabilities: ["view", "upload"] },
};

const i18n = i18next.createInstance();

function renderDrop() {
  const qc = new QueryClient();
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  const view = render(
    <I18nextProvider i18n={i18n}>
      <MantineProvider>
        <Notifications />
        <QueryClientProvider client={qc}>
          <FolderDrop project={project} />
        </QueryClientProvider>
      </MantineProvider>
    </I18nextProvider>,
  );
  return { invalidate, ...view };
}

async function drop(container: HTMLElement, files: File[]): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("no file input");
  await userEvent.upload(input, files);
}

function upload(overrides: Partial<UploadItem>): UploadItem {
  return {
    id: "up1",
    filename: "bass.wav",
    size: 1024,
    target: { type: "newTrack", songId: "s1", name: "Bass" },
    songId: "s1",
    projectId: "p1",
    progress: 0.5,
    status: "uploading",
    errorCode: null,
    errorParams: null,
    ...overrides,
  };
}

describe("FolderDrop (SPEC §5.1)", () => {
  beforeAll(async () => {
    await initI18n("en", i18n);
  });
  beforeEach(() => {
    vi.mocked(startUpload).mockReset();
  });
  afterEach(() => {
    notifications.clean();
    useUploads.setState({ items: [] });
    vi.unstubAllGlobals();
  });

  it("reports a failing song creation and still refreshes the lists", async () => {
    mockApi({
      "POST /projects/p1/songs": () => ({
        status: 413,
        body: { code: "QUOTA_EXCEEDED", message: "full" },
      }),
    });
    const { container, invalidate } = renderDrop();
    await drop(container, [new File(["x"], "take1.wav", { type: "audio/wav" })]);
    expect(await screen.findByText(i18n.t("errors.QUOTA_EXCEEDED"))).toBeInTheDocument();
    expect(screen.getByText("take1")).toBeInTheDocument();
    expect(startUpload).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalled();
    });
  });

  it("reports a failed upload with its error code", async () => {
    mockApi({ "POST /projects/p1/songs": () => ({ status: 201, body: { song } }) });
    vi.mocked(startUpload).mockRejectedValue({ code: "UNSUPPORTED_FILE", params: null });
    const { container } = renderDrop();
    await drop(container, [new File(["x"], "take1.wav", { type: "audio/wav" })]);
    expect(await screen.findByText(i18n.t("errors.UNSUPPORTED_FILE"))).toBeInTheDocument();
    expect(screen.getByText("take1.wav")).toBeInTheDocument();
    expect(startUpload).toHaveBeenCalledWith(
      expect.any(File),
      // A loose file: one track named after the song (SPEC §5.1, M21).
      { type: "newTrack", songId: "s1", name: "take1" },
      { songId: "s1", projectId: "p1" },
    );
  });

  it("unpacks a zip: its loose audio files become one song named after the zip (SPEC §28.1)", async () => {
    const titles: string[] = [];
    mockApi({
      "POST /projects/p1/songs": (init) => {
        const { title } = JSON.parse(init?.body as string) as { title: string };
        titles.push(title);
        return { status: 201, body: { song: { ...song, id: `s-${title}`, title } } };
      },
    });
    vi.mocked(startUpload).mockResolvedValue({ assetId: "a", trackId: "t", trackVersionId: "v" });
    const zip = new File(
      [
        zipSync({
          "Rehearsal/Gig_Bass.wav": strToU8("b"),
          "Rehearsal/Gig_Drums.wav": strToU8("d"),
          "Rehearsal/notes.txt": strToU8("n"),
          "__MACOSX/Rehearsal/._Gig_Bass.wav": strToU8("x"),
        }),
      ],
      "Rehearsal 3.zip",
      { type: "application/zip" },
    );
    const { container } = renderDrop();
    await drop(container, [zip]);
    await waitFor(() => {
      expect(startUpload).toHaveBeenCalledTimes(2);
    });
    expect(titles).toEqual(["Rehearsal 3"]);
    expect(vi.mocked(startUpload).mock.calls.map((c) => c[1])).toEqual([
      { type: "newTrack", songId: "s-Rehearsal 3", name: "Bass" },
      { type: "newTrack", songId: "s-Rehearsal 3", name: "Drums" },
    ]);
  });

  it("groups a picked folder by its subfolders (SPEC §28.1)", async () => {
    Object.defineProperty(HTMLInputElement.prototype, "webkitdirectory", {
      configurable: true,
      value: false,
    });
    try {
      const titles: string[] = [];
      mockApi({
        "POST /projects/p1/songs": (init) => {
          const { title } = JSON.parse(init?.body as string) as { title: string };
          titles.push(title);
          return { status: 201, body: { song: { ...song, id: `s-${title}`, title } } };
        },
      });
      vi.mocked(startUpload).mockResolvedValue({
        assetId: "a",
        trackId: "t",
        trackVersionId: "v",
      });
      const picked = [
        ["Gig/Song A/bass.wav", "bass.wav"],
        ["Gig/Song A/drums.wav", "drums.wav"],
        ["Gig/Song B/gtr.wav", "gtr.wav"],
      ].map(([path, name]) => {
        const f = new File(["x"], name ?? "", { type: "audio/wav" });
        Object.defineProperty(f, "webkitRelativePath", { value: path });
        return f;
      });
      renderDrop();
      const button = screen.getByTestId("project-upload-folder");
      expect(button).toHaveTextContent(i18n.t("songs.uploadFolder"));
      const input = document.querySelector<HTMLInputElement>("input[webkitdirectory]");
      if (!input) throw new Error("no folder input");
      fireEvent.change(input, { target: { files: picked } });
      await waitFor(() => {
        expect(startUpload).toHaveBeenCalledTimes(3);
      });
      expect(titles).toEqual(["Song A", "Song B"]);
    } finally {
      Reflect.deleteProperty(HTMLInputElement.prototype, "webkitdirectory");
    }
  });

  it("has no folder button where the browser cannot pick folders", () => {
    renderDrop();
    expect(screen.queryByTestId("project-upload-folder")).toBeNull();
  });

  it("lists this project's track uploads", () => {
    useUploads.setState({
      items: [
        upload({ id: "a", filename: "bass.wav" }),
        upload({ id: "b", filename: "other.wav", projectId: otherProject }),
        upload({ id: "c", filename: "cover.png", songId: null }),
        upload({ id: "d", filename: "done.wav", status: "done" }),
        upload({
          id: "e",
          filename: "lyrics.md",
          target: { type: "newDocument", projectId: "p1", songId: "s1" },
        }),
        upload({ id: "f", filename: "drums.wav", status: "error", errorCode: "DISK_FULL" }),
      ],
    });
    renderDrop();
    const rows = screen.getAllByTestId("upload-row");
    expect(rows.map((r) => within(r).getByText(/\.wav$/).textContent)).toEqual([
      "bass.wav",
      "drums.wav",
    ]);
    expect(screen.getByText(i18n.t("errors.DISK_FULL"))).toBeInTheDocument();
  });
});
