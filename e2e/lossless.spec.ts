import fs from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { generateFixtures, TONE_FILE } from "@bandroom/fixtures";
import { loginAsNewUser, uniqueUsername } from "./helpers";

/** M20 group B: remove full quality and the lossy badges (SPEC §26.4). */

test.beforeAll(async () => {
  await generateFixtures();
});

const CSRF = { "X-Requested-With": "bandroom" };

/** A new project (the creator manages it) with one song; returns both ids. */
async function projectWithSong(page: Page, name: string, title: string) {
  const res = await page.request.post("api/v1/projects", { headers: CSRF, data: { name } });
  const { project } = (await res.json()) as { project: { id: string } };
  const s = await page.request.post(`api/v1/projects/${project.id}/songs`, {
    headers: CSRF,
    data: { title },
  });
  const { song } = (await s.json()) as { song: { id: string } };
  return { projectId: project.id, songId: song.id };
}

/** Uploads WAV tracks into an empty song and waits until they are processed. */
async function uploadTracks(page: Page, names: string[]) {
  const tone = await fs.readFile(TONE_FILE());
  await page
    .getByTestId("track-dropzone")
    .locator('input[type="file"]')
    .setInputFiles(names.map((n) => ({ name: `${n}.wav`, mimeType: "audio/wav", buffer: tone })));
  const rows = page.getByTestId("track-row");
  await expect(rows).toHaveCount(names.length, { timeout: 60_000 });
  await expect(page.getByTestId("track-processing")).toHaveCount(0, { timeout: 120_000 });
  await expect(rows.getByTestId("version-button")).toHaveCount(names.length);
}

/** Opens a track's "⋯" menu and returns which downloads it offers. */
async function downloadsOf(page: Page, track: string): Promise<string[]> {
  await page
    .getByTestId("track-row")
    .filter({ hasText: track })
    .getByTestId("track-actions")
    .click();
  const items = page.locator('[data-testid^="download-"]');
  await expect(items.first()).toBeVisible();
  const ids = await items.evaluateAll((els) => els.map((e) => e.getAttribute("data-testid") ?? ""));
  await page.keyboard.press("Escape");
  await expect(items).toHaveCount(0);
  return ids.map((id) => id.replace("download-", "")).sort();
}

async function confirmRemoval(page: Page) {
  const dialog = page.getByTestId("lossless-dialog");
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("lossless-confirm")).toBeDisabled();
  await page.getByTestId("lossless-confirm-input").fill("remove");
  await page.getByTestId("lossless-confirm").click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
}

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test("select tracks and songs → remove full quality → lossy badges, no lossless download", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  await loginAsNewUser(page, page.request, testInfo, "member");
  const { projectId, songId } = await projectWithSong(
    page,
    `Lossy ${uniqueUsername(testInfo)}`,
    "Rehearsal",
  );
  await page.goto(`songs/${songId}`);
  await uploadTracks(page, ["Bass", "Keys"]);
  expect(await downloadsOf(page, "Bass")).toEqual(["flac", "opus", "wav"]);

  // Tracks: select Bass → Remove full quality → preview → typed confirmation.
  await page.getByTestId("tracks-select").click();
  await page.getByTestId("track-row").filter({ hasText: "Bass" }).click();
  await page.getByTestId("tracks-selection-bar").getByTestId("selection-removeLossless").click();
  await expect(page.getByTestId("lossless-summary")).toContainText("1 version loses");
  await expect(page.getByTestId("lossless-summary")).toContainText("1 FLAC file");
  await confirmRemoval(page);
  const bass = page.getByTestId("track-row").filter({ hasText: "Bass" });
  await expect(bass.getByTestId("lossy-badge")).toHaveAttribute("data-reason", "removed", {
    timeout: 30_000,
  });
  await expect(
    page.getByTestId("track-row").filter({ hasText: "Keys" }).getByTestId("lossy-badge"),
  ).toHaveCount(0);
  expect(await downloadsOf(page, "Bass")).toEqual(["opus"]);
  expect(await downloadsOf(page, "Keys")).toEqual(["flac", "opus", "wav"]);

  // The version stack says when and by whom.
  await bass.getByTestId("version-button").click();
  await expect(page.getByTestId("version-archived")).toContainText(/Full quality removed on/);
  await page.keyboard.press("Escape");

  // Song list: "Partly lossy"; removing the song's full quality skips Bass and makes it "Lossy".
  await page.goto(`projects/${projectId}`);
  const row = page.getByTestId("song-row").filter({ hasText: "Rehearsal" });
  await expect(row.getByTestId("song-lossy-badge")).toHaveAttribute("data-lossy", "partial", {
    timeout: 30_000,
  });
  await page.getByTestId("songs-select").click();
  await row.getByTestId("song-row-link").click();
  await page.getByTestId("selection-removeLossless").click();
  await expect(page.getByTestId("lossless-skipped")).toContainText("1 version is already lossy");
  expect(await noHorizontalScroll(page)).toBe(true);
  await confirmRemoval(page);
  await expect(row.getByTestId("song-lossy-badge")).toHaveAttribute("data-lossy", "all", {
    timeout: 30_000,
  });
});

test("remove one version's full quality from the stack on a 360 px phone", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 360, height: 740 });
  await loginAsNewUser(page, page.request, testInfo, "member");
  const { songId } = await projectWithSong(page, `Stack ${uniqueUsername(testInfo)}`, "Take");
  await page.goto(`songs/${songId}`);
  await uploadTracks(page, ["Guitar"]);

  await page.getByTestId("version-button").click();
  const stack = page.getByTestId("version-stack");
  await stack.getByTestId("version-actions").click();
  await page.getByTestId("remove-lossless-version").click();
  const confirm = page.getByTestId("lossless-confirm");
  await expect(confirm).toBeVisible({ timeout: 30_000 });
  expect((await confirm.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(await noHorizontalScroll(page)).toBe(true);
  await confirmRemoval(page);
  await expect(stack.getByTestId("lossy-badge")).toBeVisible({ timeout: 30_000 });
  await expect(stack.getByTestId("version-archived")).toBeVisible();
  // The single-version entry is gone once the full quality is removed.
  await stack.getByTestId("version-actions").click();
  await expect(page.getByTestId("remove-lossless-version")).toHaveCount(0);
});

test("upload with lossy on upload: Opus only, the badge says converted on upload (SPEC §28.2)", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 360, height: 740 });
  await loginAsNewUser(page, page.request, testInfo, "member");
  const { songId } = await projectWithSong(page, `OnUpload ${uniqueUsername(testInfo)}`, "Take");
  await page.goto(`songs/${songId}`);

  // The settings next to the dropzone, remembered on this device.
  const settings = page.getByTestId("track-upload-settings");
  await expect(settings).toHaveText("Keep full quality");
  expect((await settings.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await settings.click();
  await page.getByRole("switch", { name: "Convert to lossy on upload" }).check();
  await page.getByTestId("upload-quality").click();
  await page.getByRole("option", { name: /^High/ }).click();
  await expect(settings).toHaveText("Lossy on upload · 128 kbps stereo / 80 kbps mono");
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.keyboard.press("Escape");

  await uploadTracks(page, ["Vox"]);
  const vox = page.getByTestId("track-row").filter({ hasText: "Vox" });
  await expect(vox.getByTestId("lossy-badge")).toHaveAttribute("data-reason", "upload", {
    timeout: 30_000,
  });
  expect(await downloadsOf(page, "Vox")).toEqual(["opus"]);
  await vox.getByTestId("version-button").click();
  await expect(page.getByTestId("version-archived")).toContainText(
    /Converted to lossy on upload on/,
  );
  await expect(page.getByTestId("version-stack")).toContainText("Opus 128 kbps");
  await page.keyboard.press("Escape");

  await page.reload();
  await expect(page.getByTestId("track-upload-settings")).toHaveText(
    "Lossy on upload · 128 kbps stereo / 80 kbps mono",
  );
});

test("remove full quality at another Opus quality: re-encoded first (SPEC §28.3)", async ({
  page,
}, testInfo) => {
  test.setTimeout(360_000);
  await loginAsNewUser(page, page.request, testInfo, "member");
  const { songId } = await projectWithSong(page, `Reencode ${uniqueUsername(testInfo)}`, "Take");
  await page.goto(`songs/${songId}`);
  await uploadTracks(page, ["Gtr"]);

  await page.getByTestId("tracks-select").click();
  await page.getByTestId("track-row").filter({ hasText: "Gtr" }).click();
  await page.getByTestId("tracks-selection-bar").getByTestId("selection-removeLossless").click();
  const quality = page.getByTestId("lossless-quality");
  await expect(quality).toHaveValue("Keep the existing compressed copy (Standard)", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("lossless-now")).toHaveText(
    "Now: full quality (FLAC) · compressed copy Opus Standard (96 kbps stereo)",
  );
  await quality.click();
  await page.getByRole("option", { name: /^High/ }).click();
  await expect(page.getByTestId("lossless-reencode")).toContainText("1 version is re-encoded");
  await confirmRemoval(page);

  const gtr = page.getByTestId("track-row").filter({ hasText: "Gtr" });
  // The re-encode queues behind other tests' jobs on the one e2e worker.
  await expect(gtr.getByTestId("lossy-badge")).toHaveAttribute("data-reason", "reencode", {
    timeout: 180_000,
  });
  expect(await downloadsOf(page, "Gtr")).toEqual(["opus"]);
  await gtr.getByTestId("version-button").click();
  await expect(page.getByTestId("version-stack")).toContainText("Opus 128 kbps");
  await expect(page.getByTestId("version-archived")).toContainText(/Re-encoded and full quality/);
});
