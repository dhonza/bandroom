import type { UploadTarget } from "@bandroom/shared";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initI18n } from "../i18n/i18n";
import { mockApi } from "../test/mockApi";
import type * as Takes from "./takes";
import type { TakeMeta } from "./takeTypes";

const saved = vi.hoisted(() => [] as { target: UploadTarget; filename: string }[]);
vi.mock("./takes", async (importOriginal) => ({
  ...(await importOriginal<typeof Takes>()),
  saveTake: (_m: TakeMeta, c: { target: UploadTarget; filename: string }) => {
    saved.push(c);
    return Promise.resolve();
  },
}));

const { TakeDialog } = await import("./TakeDialog");

const i18n = i18next.createInstance();

const take = (over: Partial<TakeMeta> = {}): TakeMeta => ({
  v: 1,
  takeId: "t1",
  userId: "u1",
  mode: "project",
  songId: null,
  projectId: "p1",
  startFrame: 0,
  latencyFrames: 0,
  trimmedFrames: 0,
  channels: 1,
  format: "flac",
  frames: 48_000,
  peak: 0.125,
  status: "finished",
  endedBy: "user",
  gapFrames: 0,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

function renderDialog(meta: TakeMeta) {
  render(
    <I18nextProvider i18n={i18n}>
      <MantineProvider>
        <QueryClientProvider client={new QueryClient()}>
          <TakeDialog meta={meta} />
        </QueryClientProvider>
      </MantineProvider>
    </I18nextProvider>,
  );
}

const instance = (peakTargetDb: number) =>
  mockApi({
    "GET /meta": () => ({
      body: {
        instanceName: "BandRoom",
        version: "0.0.0",
        locales: ["en", "cs"],
        defaultLocale: "en",
        logoHash: null,
        recordingMaxTakeMinutes: 180,
        recordingPeakTargetDb: peakTargetDb,
      },
    }),
  });

describe("stop dialog auto level (SPEC §9)", () => {
  beforeAll(async () => {
    await initI18n("en", i18n);
  });
  afterEach(() => {
    saved.length = 0;
    vi.unstubAllGlobals();
  });

  it("sets the gain from the instance's target peak, changeable per take", async () => {
    instance(-3);
    renderDialog(take());
    // Peak −18.06 dBFS → target −3: +15 dB.
    await waitFor(() => {
      expect(screen.getByTestId("take-auto-gain").dataset.gain).toBe("15");
    });
    const field = screen.getByTestId("take-peak-target");
    await userEvent.clear(field);
    await userEvent.type(field, "-12{Enter}");
    expect(screen.getByTestId("take-auto-gain").dataset.gain).toBe("6");
    expect(screen.getByTestId("take-auto-gain").textContent).toContain("+6 dB");
    await userEvent.click(screen.getByTestId("take-save"));
    expect(saved[0]?.target).toMatchObject({ type: "newSong", gainDb: 6 });
    expect(saved[0]?.filename.endsWith(".flac")).toBe(true);
  });

  it("sends no gain when switched off, and offers none without a peak", async () => {
    instance(-6);
    renderDialog(take({ format: "wav32f" }));
    await userEvent.click(screen.getByTestId("take-auto-level"));
    await userEvent.click(screen.getByTestId("take-save"));
    expect(saved[0]?.target).not.toHaveProperty("gainDb");
    expect(saved[0]?.filename.endsWith(".wav")).toBe(true);
  });

  it("hides the auto level for a take without a peak", () => {
    instance(-6);
    const { peak: _p, ...noPeak } = take();
    renderDialog(noPeak);
    expect(screen.queryByTestId("take-auto-level")).toBeNull();
  });
});
