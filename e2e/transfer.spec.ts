import fs from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { generateFixtures, TONE_FILE } from "@bandroom/fixtures";
import { loginAsNewUser, uniqueUsername } from "./helpers";

/** M20 group C: make multitrack song, copy and move (SPEC §26.5, §26.6). */

test.beforeAll(async () => {
  await generateFixtures();
});

const CSRF = { "X-Requested-With": "bandroom" };

/** A new project (the creator manages it) with songs created over the API. */
async function projectWithSongs(page: Page, name: string, titles: string[]) {
  const res = await page.request.post("api/v1/projects", { headers: CSRF, data: { name } });
  const { project } = (await res.json()) as { project: { id: string } };
  const songIds: string[] = [];
  for (const title of titles) {
    const s = await page.request.post(`api/v1/projects/${project.id}/songs`, {
      headers: CSRF,
      data: { title },
    });
    songIds.push(((await s.json()) as { song: { id: string } }).song.id);
  }
  return { projectId: project.id, songIds };
}

/** Uploads one WAV track into an empty song (processing may still run). */
async function uploadTrack(page: Page, songId: string, name: string) {
  await page.goto(`songs/${songId}`);
  const tone = await fs.readFile(TONE_FILE());
  await page
    .getByTestId("track-dropzone")
    .locator('input[type="file"]')
    .setInputFiles({ name: `${name}.wav`, mimeType: "audio/wav", buffer: tone });
  await expect(page.getByTestId("track-row")).toHaveCount(1, { timeout: 60_000 });
}

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test("make a multitrack song from two songs", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await loginAsNewUser(page, page.request, testInfo, "member");
  const { projectId, songIds } = await projectWithSongs(page, `Multi ${uniqueUsername(testInfo)}`, [
    "Night Train - band",
    "Night Train - vocals",
  ]);
  await uploadTrack(page, songIds[0] ?? "", "Drums");
  await uploadTrack(page, songIds[1] ?? "", "Vox");

  await page.goto(`projects/${projectId}`);
  const rows = page.getByTestId("song-row");
  await expect(rows).toHaveCount(2, { timeout: 30_000 });
  await page.getByTestId("songs-select").click();
  await page.getByTestId("selection-all").click();
  await page.getByTestId("selection-makeMultitrack").click();
  const dialog = page.getByTestId("multitrack-dialog");
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByTestId("multitrack-tracks").locator("tr")).toHaveCount(2);
  await expect(page.getByTestId("multitrack-name")).toHaveValue("Night Train");
  await expect(page.getByTestId("multitrack-emptied")).toBeVisible();
  // Track names are editable, prefilled with the final names.
  const names = dialog.getByTestId("multitrack-track-name");
  await expect(names).toHaveCount(2);
  await names.nth(0).fill("Drum kit");
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.getByTestId("multitrack-submit").click();

  // The new song opens with both tracks; the sources are in the Trash.
  await expect(page).toHaveURL(/songs\//, { timeout: 30_000 });
  await expect(page.getByTestId("track-row")).toHaveCount(2, { timeout: 30_000 });
  await expect(page.getByTestId("track-row").first()).toContainText("Drum kit");
  await page.goto(`projects/${projectId}`);
  await expect(rows).toHaveCount(1, { timeout: 30_000 });
  await expect(rows).toContainText("Night Train");
  await page.goto(`projects/${projectId}?tab=trash`);
  await expect(page.getByTestId("trash-row")).toHaveCount(2, { timeout: 30_000 });
});

test("copy a song to a new project", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await loginAsNewUser(page, page.request, testInfo, "member");
  const { projectId } = await projectWithSongs(page, `Copy ${uniqueUsername(testInfo)}`, [
    "Keeper",
  ]);
  await page.goto(`projects/${projectId}`);
  const rows = page.getByTestId("song-row");
  await expect(rows).toHaveCount(1, { timeout: 30_000 });
  await page.getByTestId("songs-select").click();
  await page.getByTestId("selection-all").click();
  await page.getByTestId("selection-copyMove").click();
  await page.getByTestId("selection-newProject").click();
  const dialog = page.getByTestId("songs-transfer-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Copy", { exact: true }).check();
  const name = `Fresh ${uniqueUsername(testInfo)}`;
  await page.getByTestId("transfer-new-name").fill(name);
  await page.getByTestId("songs-transfer-submit").click();

  // The new project opens with the copy; the original stays.
  await expect(page).not.toHaveURL(new RegExp(`projects/${projectId}`), { timeout: 30_000 });
  await expect(page.getByRole("heading", { name })).toBeVisible({ timeout: 30_000 });
  await expect(rows).toHaveCount(1, { timeout: 30_000 });
  await expect(rows).toContainText("Keeper");
  await page.goto(`projects/${projectId}`);
  await expect(rows).toHaveCount(1, { timeout: 30_000 });
});

test("move a song to another project", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await loginAsNewUser(page, page.request, testInfo, "member");
  const fromName = `From ${uniqueUsername(testInfo)}`;
  const from = await projectWithSongs(page, fromName, ["Wanderer"]);
  const toName = `To ${uniqueUsername(testInfo)}`;
  const to = await projectWithSongs(page, toName, []);
  await page.goto(`projects/${from.projectId}`);
  const rows = page.getByTestId("song-row");
  await expect(rows).toHaveCount(1, { timeout: 30_000 });
  await page.getByTestId("songs-select").click();
  await page.getByTestId("selection-all").click();
  await page.getByTestId("selection-copyMove").click();
  await page.getByTestId("selection-moveTo").click();
  await expect(page.getByTestId("songs-transfer-dialog")).toBeVisible();
  await page.getByTestId("transfer-target").selectOption({ label: toName });
  await page.getByTestId("songs-transfer-submit").click();

  await expect(page).toHaveURL(new RegExp(`projects/${to.projectId}`), { timeout: 30_000 });
  await expect(rows).toHaveCount(1, { timeout: 30_000 });
  await expect(rows).toContainText("Wanderer");
  await page.goto(`projects/${from.projectId}`);
  await expect(page.getByRole("heading", { name: fromName })).toBeVisible({ timeout: 30_000 });
  await expect(rows).toHaveCount(0, { timeout: 30_000 });
});
