import type { Document, DocumentVersion } from "@bandroom/shared";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initI18n } from "../i18n/i18n";
import { DocumentEditor } from "./DocumentActions";

const i18n = i18next.createInstance();

const version: DocumentVersion = {
  id: "v1",
  documentId: "d1",
  number: 1,
  notes: "",
  source: "upload",
  createdAt: 0,
  uploadedBy: "u1",
  uploaderName: "Jana",
  originalFilename: "lyrics.txt",
  sizeBytes: 5,
  status: "ready",
  error: null,
  kind: "text",
  pages: null,
  thumbHash: null,
  previewHash: null,
  isCurrent: true,
  canDelete: true,
};

const doc = {
  id: "d1",
  projectId: "p1",
  songId: null,
  songTitle: null,
  title: "Lyrics",
  kind: "text",
  sortOrder: 0,
  createdBy: "u1",
  createdAt: 0,
  versionCount: 1,
  current: version,
  canDownload: true,
  canEdit: true,
  canDelete: true,
  canSetCurrent: true,
} as Document;

/** Serves the version text (or a failure) and records save requests. */
function stubFetch(content: { status: number; text: string }) {
  const saves: unknown[] = [];
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const raw = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    const path = new URL(raw, "http://localhost").pathname;
    if (path.endsWith("/document-versions/v1/content"))
      return Promise.resolve(new Response(content.text, { status: content.status }));
    if (path.endsWith("/documents/d1/versions") && init?.method === "POST") {
      saves.push(JSON.parse(init.body as string));
      return Promise.resolve(
        new Response(JSON.stringify({ document: doc }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  });
  vi.stubGlobal("fetch", fn);
  return saves;
}

function renderEditor() {
  const onClose = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <I18nextProvider i18n={i18n}>
      <MantineProvider>
        <QueryClientProvider client={qc}>
          <DocumentEditor doc={doc} version={version} onClose={onClose} />
        </QueryClientProvider>
      </MantineProvider>
    </I18nextProvider>,
  );
  return { onClose };
}

describe("DocumentEditor", () => {
  beforeAll(async () => {
    await initI18n("en", i18n);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not offer editing or saving when the text failed to load", async () => {
    stubFetch({ status: 500, text: "" });
    renderEditor();
    expect(await screen.findByTestId("doc-editor-load-error")).toHaveTextContent(
      i18n.t("documents.editLoadFailed"),
    );
    expect(screen.queryByTestId("doc-editor")).not.toBeInTheDocument();
    expect(screen.getByTestId("doc-editor-save")).toBeDisabled();
  });

  it("closes without asking when nothing changed", async () => {
    stubFetch({ status: 200, text: "hello" });
    const { onClose } = renderEditor();
    await screen.findByDisplayValue("hello");
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("asks before Escape discards unsaved edits", async () => {
    stubFetch({ status: 200, text: "hello" });
    const { onClose } = renderEditor();
    const box = await screen.findByDisplayValue("hello");
    await userEvent.type(box, " world");
    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    expect(await screen.findByTestId("doc-editor-discard-confirm")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: i18n.t("documents.keepEditing") }));
    expect(screen.getByDisplayValue("hello world")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: i18n.t("common.cancel") }));
    await userEvent.click(await screen.findByTestId("doc-editor-discard"));
    expect(onClose).toHaveBeenCalled();
  });

  it("saves the edited text as a new version", async () => {
    const saves = stubFetch({ status: 200, text: "hello" });
    const { onClose } = renderEditor();
    const box = await screen.findByDisplayValue("hello");
    await userEvent.type(box, "!");
    await userEvent.click(screen.getByTestId("doc-editor-save"));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(saves).toEqual([{ text: "hello!", baseVersionId: "v1" }]);
  });
});
