import type { RemoveLosslessPreview } from "@bandroom/shared";
import { MantineProvider } from "@mantine/core";
import { Notifications, notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initI18n } from "../i18n/i18n";
import { mockApi } from "../test/mockApi";
import { RemoveLosslessDialog } from "./RemoveLosslessDialog";

const i18n = i18next.createInstance();

const preview = (reencode: number): RemoveLosslessPreview => ({
  versions: 2,
  files: { flac: 2, original: 0, wavmeta: 0 },
  usageBytes: 2048,
  bytesFreed: 2048,
  lossySources: { count: 0, items: [] },
  sharedCopies: 0,
  skipped: { notReady: 0, alreadyLossy: 0 },
  reencode,
  currentOpus: [{ kbps: 96, count: 2 }],
});

describe("remove full quality with a quality choice (SPEC §28.3)", () => {
  beforeAll(async () => {
    await initI18n("en", i18n);
  });
  afterEach(() => {
    notifications.clean();
    vi.unstubAllGlobals();
  });

  it("re-previews per quality and sends the chosen one", async () => {
    const bodies: unknown[] = [];
    const posted: unknown[] = [];
    mockApi({
      "POST /batch/remove-lossless/preview": (init) => {
        const body = JSON.parse(init?.body as string) as { quality?: string };
        bodies.push(body);
        return { body: preview(body.quality === "high" ? 2 : 0) };
      },
      "POST /batch/remove-lossless": (init) => {
        posted.push(JSON.parse(init?.body as string));
        return {
          body: {
            ok: true,
            batchId: "b",
            count: 0,
            usageBytes: 2048,
            bytesFreed: 2048,
            reencoding: 2,
          },
        };
      },
    });
    const onClose = vi.fn();
    render(
      <I18nextProvider i18n={i18n}>
        <MantineProvider>
          <Notifications />
          <QueryClientProvider client={new QueryClient()}>
            <RemoveLosslessDialog items={{ tracks: ["t1", "t2"] }} onClose={onClose} />
          </QueryClientProvider>
        </MantineProvider>
      </I18nextProvider>,
    );
    const select = await screen.findByTestId("lossless-quality");
    expect(select).toHaveValue("Keep current (96 kbps)");
    expect(screen.queryByTestId("lossless-reencode")).toBeNull();

    await userEvent.click(select);
    await userEvent.click(
      await screen.findByRole("option", { name: /^High · 128 kbps/, hidden: true }),
    );
    expect(await screen.findByTestId("lossless-reencode")).toHaveTextContent(
      "2 versions are re-encoded first",
    );
    expect(bodies.at(-1)).toEqual({ tracks: ["t1", "t2"], quality: "high" });

    await userEvent.type(screen.getByTestId("lossless-confirm-input"), "remove");
    await userEvent.click(screen.getByTestId("lossless-confirm"));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(posted).toEqual([{ tracks: ["t1", "t2"], quality: "high" }]);
    expect(
      await screen.findByText(/2 versions are being re-encoded; their full quality goes/),
    ).toBeInTheDocument();
  });
});
