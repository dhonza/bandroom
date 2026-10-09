import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { isMobile, loginAsNewUser, uniqueUsername } from "./helpers";

/**
 * Recording (SPEC §9) with Chromium's fake microphone (a beep, see playwright.config.ts). WebKit
 * has a mock microphone but no OPFS in Playwright's private sessions, so it only checks that the
 * microphone opens; full recording and the phone projects are tested on devices.
 */

const MIC_OPENS = "The microphone opens and arms";

const CSRF = { "X-Requested-With": "bandroom" };

test.beforeEach(({ browserName }, testInfo) => {
  test.skip(
    isMobile(testInfo) ||
      !(browserName === "chromium" || (browserName === "webkit" && testInfo.title === MIC_OPENS)),
    "fake microphone: desktop Chromium (WebKit: arming only)",
  );
  test.setTimeout(240_000);
});

interface ApiTrack {
  id: string;
  name: string;
  current: {
    id: string;
    source: string;
    offsetSamples: number;
    status: string;
    label: string;
    gainDb: number;
  };
}

async function projectWithSong(page: Page, testInfo: TestInfo, tempo: boolean) {
  const res = await page.request.post("api/v1/projects", {
    headers: CSRF,
    data: { name: `Rec ${uniqueUsername(testInfo)}` },
  });
  const { project } = (await res.json()) as { project: { id: string } };
  const s = await page.request.post(`api/v1/projects/${project.id}/songs`, {
    headers: CSRF,
    data: { title: "Take me" },
  });
  const { song } = (await s.json()) as { song: { id: string } };
  if (tempo) {
    const put = await page.request.put(`api/v1/songs/${song.id}/tempo`, {
      headers: CSRF,
      data: {
        map: { segments: [{ startBeat: 0, bpm: 120, meter: { num: 4, den: 4 } }] },
        bar1OffsetSec: 0,
      },
    });
    expect(put.status()).toBe(200);
  }
  return { projectId: project.id, songId: song.id };
}

async function tracksOf(page: Page, songId: string): Promise<ApiTrack[]> {
  const res = await page.request.get(`api/v1/songs/${songId}/tracks`);
  return ((await res.json()) as { tracks: ApiTrack[] }).tracks;
}

/** Opens the song's record sheet and waits until the microphone is armed. */
async function openRecorder(page: Page) {
  await page.getByTestId("record-open").click();
  const panel = page.getByTestId("record-panel");
  await expect(panel).toHaveAttribute("data-phase", "armed", { timeout: 60_000 });
  await expect(page.getByTestId("record-meter")).toBeVisible();
  return panel;
}

/** Records about `seconds` (timer), then stops. */
async function recordFor(page: Page, seconds: number) {
  await page.getByTestId("record-start").click();
  await expect(page.getByTestId("record-timer")).toHaveText(`0:0${String(seconds)}`, {
    timeout: 60_000,
  });
}

// WebKit refuses capture while the audio session is "playback" (set by the Player).
test(MIC_OPENS, async ({ page, request }, testInfo) => {
  await loginAsNewUser(page, request, testInfo);
  const { songId } = await projectWithSong(page, testInfo, true);
  await page.goto(`songs/${songId}`);
  await openRecorder(page);
  await expect(page.getByTestId("record-start")).toBeEnabled();
});

test("Song page: record a take, save it as a new track, then adjust its position", async ({
  page,
  request,
}, testInfo) => {
  await loginAsNewUser(page, request, testInfo, "member");
  const { songId } = await projectWithSong(page, testInfo, true);
  await page.goto(`songs/${songId}`);
  await expect(page.getByTestId("rehearse-transport")).toBeVisible();

  const panel = await openRecorder(page);
  // A tempo map: the count-in switch is offered; the hint says what plays.
  await expect(panel.getByTestId("record-count-in")).toBeVisible();
  // Input gain typed in dB: the slider follows.
  const gainInput = panel.getByTestId("record-gain-input");
  await gainInput.fill("12");
  await gainInput.blur();
  await expect(panel.getByTestId("record-gain-slider").getByRole("slider")).toHaveAttribute(
    "aria-valuenow",
    "12",
  );
  await recordFor(page, 3);
  await page.getByTestId("record-stop").click();

  const dialog = page.getByTestId("take-dialog-body");
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByTestId("take-name")).toHaveValue("Recording 1");
  // Auto level: on, with the resulting gain shown.
  await expect(dialog.getByTestId("take-auto-level")).toBeChecked();
  await expect(dialog.getByTestId("take-auto-gain")).toHaveAttribute("data-gain", /\d/);
  await dialog.getByTestId("take-label").fill("first take");
  // Recorded from 0: the latency reaches before the start, so it starts at 0 plus the nudge.
  await dialog.getByTestId("nudge-plus-10").click();
  await expect(dialog.getByTestId("take-offset")).toHaveAttribute("data-offset", "480");
  await dialog.getByTestId("take-save").click();
  await expect(dialog).toBeHidden();

  await expect(page.getByTestId("track-row").filter({ hasText: "Recording 1" })).toBeVisible({
    timeout: 60_000,
  });
  await expect
    .poll(async () => (await tracksOf(page, songId))[0]?.current.status, { timeout: 120_000 })
    .toBe("ready");
  const [track] = await tracksOf(page, songId);
  expect(track?.current).toMatchObject({
    source: "recording",
    offsetSamples: 480,
    label: "first take",
  });
  // The auto level set the new version's gain.
  expect(track?.current.gainDb).not.toBe(0);

  // Adjust position: +100 ms, saved.
  const row = page.getByTestId("track-row").filter({ hasText: "Recording 1" });
  await row.getByTestId("track-actions").click();
  await page.getByTestId("adjust-position-open").click();
  const adjust = page.getByTestId("adjust-position");
  await adjust.getByTestId("nudge-plus-100").click();
  await expect(adjust.getByTestId("adjust-offset")).toHaveAttribute("data-offset", "5280");
  await adjust.getByTestId("adjust-save").click();
  await expect(adjust).toBeHidden();
  await expect
    .poll(async () => (await tracksOf(page, songId))[0]?.current.offsetSamples)
    .toBe(5280);
});

test("A 32-bit float take uploads", async ({ page, request }, testInfo) => {
  await loginAsNewUser(page, request, testInfo, "member");
  const { songId } = await projectWithSong(page, testInfo, false);
  await page.goto(`songs/${songId}`);
  const panel = await openRecorder(page);
  await panel.getByTestId("record-float").check();
  // The recorder re-arms for the float format.
  await expect(panel).toHaveAttribute("data-phase", "armed", { timeout: 60_000 });
  await expect(page.getByTestId("record-start")).toBeEnabled();
  await recordFor(page, 2);
  await page.getByTestId("record-stop").click();

  const dialog = page.getByTestId("take-dialog-body");
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await dialog.getByTestId("take-save").click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(async () => (await tracksOf(page, songId))[0]?.current.status, { timeout: 120_000 })
    .toBe("ready");
  const [track] = await tracksOf(page, songId);
  expect(track?.current.source).toBe("recording");
});

test("Project page: record a new song", async ({ page, request }, testInfo) => {
  await loginAsNewUser(page, request, testInfo, "member");
  const { projectId } = await projectWithSong(page, testInfo, false);
  await page.goto(`projects/${projectId}`);
  await page.getByTestId("project-record").click();
  const panel = page.getByTestId("record-panel");
  await expect(panel).toHaveAttribute("data-phase", "armed", { timeout: 60_000 });
  // No tempo, no song: no count-in, no "what plays" hint.
  await expect(panel.getByTestId("record-count-in")).toHaveCount(0);
  await recordFor(page, 2);
  await page.getByTestId("record-stop").click();

  const dialog = page.getByTestId("take-dialog-body");
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByTestId("take-title")).toHaveValue(/^Recording /);
  await dialog.getByTestId("take-title").fill("Rehearsal take");
  await dialog.getByTestId("take-save").click();

  // The new song opens once uploaded.
  await expect(page.getByTestId("song-title")).toHaveText("Rehearsal take", { timeout: 60_000 });
  const songId = /songs\/([^/?#]+)/.exec(page.url())?.[1] ?? "";
  const [track] = await tracksOf(page, songId);
  expect(track).toMatchObject({ name: "Recording 1", current: { source: "recording" } });
});

test("Offline: a take waits and uploads on reconnect", async ({
  page,
  context,
  request,
}, testInfo) => {
  await loginAsNewUser(page, request, testInfo, "member");
  const { songId } = await projectWithSong(page, testInfo, false);
  await page.goto(`songs/${songId}`);
  await openRecorder(page);
  await context.setOffline(true);
  await expect(page.getByTestId("record-offline")).toBeVisible();
  await recordFor(page, 2);
  await page.getByTestId("record-stop").click();
  const dialog = page.getByTestId("take-dialog-body");
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await dialog.getByTestId("take-save").click();

  const pending = page.getByTestId("pending-take");
  await expect(pending).toBeVisible();
  await expect(pending).toHaveAttribute("data-status", "waiting");
  expect(await tracksOf(page, songId).catch(() => [])).toEqual([]);

  await context.setOffline(false);
  await expect(page.getByTestId("track-row").filter({ hasText: "Recording 1" })).toBeVisible({
    timeout: 60_000,
  });
  await expect(pending).toHaveCount(0);
  const [track] = await tracksOf(page, songId);
  expect(track?.current.source).toBe("recording");
});

test("A reload while recording offers to recover the take", async ({ page, request }, testInfo) => {
  await loginAsNewUser(page, request, testInfo, "member");
  const { songId } = await projectWithSong(page, testInfo, false);
  await page.goto(`songs/${songId}`);
  await openRecorder(page);
  await recordFor(page, 3);
  await page.reload();

  const dialog = page.getByTestId("take-dialog-body");
  await expect(dialog).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Recover unsaved recording")).toBeVisible();
  await dialog.getByTestId("take-save").click();
  await expect(page.getByTestId("track-row").filter({ hasText: "Recording 1" })).toBeVisible({
    timeout: 60_000,
  });
});
