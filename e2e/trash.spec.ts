import fs from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { generateFixtures, TONE_FILE } from "@bandroom/fixtures";
import { loginAsNewUser, uniqueUsername } from "./helpers";

/** M20 group A: selection, batch delete and the Trash (SPEC §26.1–§26.3). */

test.beforeAll(async () => {
  await generateFixtures();
});

const CSRF = { "X-Requested-With": "bandroom" };

/** A new project (the creator manages it) with songs created over the API. */
async function projectWithSongs(page: Page, name: string, titles: string[]) {
  const res = await page.request.post("api/v1/projects", { headers: CSRF, data: { name } });
  const { project } = (await res.json()) as { project: { id: string } };
  for (const title of titles) {
    await page.request.post(`api/v1/projects/${project.id}/songs`, {
      headers: CSRF,
      data: { title },
    });
  }
  return project.id;
}

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test("select songs → delete → Trash → restore, then delete permanently", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await loginAsNewUser(page, page.request, testInfo, "member");
  const projectId = await projectWithSongs(page, `Trash ${uniqueUsername(testInfo)}`, [
    "Alpha",
    "Beta",
    "Gamma",
  ]);
  await page.goto(`projects/${projectId}`);
  const rows = page.getByTestId("song-row");
  await expect(rows).toHaveCount(3, { timeout: 30_000 });

  // Select two songs (tapping a row selects instead of opening it) and delete them.
  await page.getByTestId("songs-select").click();
  const bar = page.getByTestId("selection-bar");
  await expect(bar).toBeVisible();
  await rows.filter({ hasText: "Alpha" }).getByTestId("song-row-link").click();
  await rows.filter({ hasText: "Gamma" }).getByTestId("song-row-link").click();
  await expect(page).toHaveURL(new RegExp(`projects/${projectId}`));
  await expect(page.getByTestId("selection-count")).toHaveText("2 selected");
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.getByTestId("selection-delete").click();
  await expect(rows).toHaveCount(1, { timeout: 30_000 });
  await expect(rows).toContainText("Beta");
  await expect(page.getByTestId("batch-undo")).toBeVisible();
  await expect(bar).toBeHidden();

  // The Trash lists both, with who deleted them; restore them together.
  await page.getByTestId("project-trash-tab").click();
  const trash = page.getByTestId("trash-row");
  await expect(trash).toHaveCount(2, { timeout: 30_000 });
  await expect(trash.first()).toContainText(/Deleted by E2E/);
  await page.getByTestId("trash-select").click();
  await page.getByTestId("selection-all").click();
  await page.getByTestId("selection-restore").click();
  await expect(page.getByTestId("trash-panel")).toContainText("The Trash is empty.", {
    timeout: 30_000,
  });
  await page.getByRole("tab", { name: /Songs/ }).click();
  await expect(rows).toHaveCount(3, { timeout: 30_000 });

  // Delete one song again and delete it permanently from the Trash (typed confirmation).
  await page.getByTestId("songs-select").click();
  await rows.filter({ hasText: "Beta" }).getByTestId("song-row-link").click();
  await page.getByTestId("selection-delete").click();
  await expect(rows).toHaveCount(2, { timeout: 30_000 });
  await page.getByTestId("project-trash-tab").click();
  await expect(trash).toHaveCount(1, { timeout: 30_000 });
  await trash.getByTestId("trash-row-menu").click();
  await page.getByTestId("trash-purge").click();
  await expect(page.getByTestId("confirm-delete")).toBeDisabled();
  await page.getByTestId("confirm-name").fill("delete");
  await page.getByTestId("confirm-delete").click();
  await expect(page.getByTestId("trash-panel")).toContainText("The Trash is empty.", {
    timeout: 30_000,
  });
});

test("select versions in the stack → delete; the Trash restores one", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await loginAsNewUser(page, page.request, testInfo, "member");
  const projectId = await projectWithSongs(page, `Versions ${uniqueUsername(testInfo)}`, ["Takes"]);
  const songs = (await (await page.request.get(`api/v1/projects/${projectId}/songs`)).json()) as {
    songs: { id: string }[];
  };
  await page.goto(`songs/${songs.songs[0]?.id ?? ""}`);
  const tone = await fs.readFile(TONE_FILE());
  const drop = page.getByTestId("track-dropzone").locator('input[type="file"]');
  await drop.setInputFiles({ name: "Mix.wav", mimeType: "audio/wav", buffer: tone });
  const mixRow = page.getByTestId("track-row").filter({ hasText: "Mix" });
  await expect(mixRow.getByTestId("version-button")).toBeVisible({ timeout: 60_000 });
  for (const n of [2, 3]) {
    await drop.setInputFiles({ name: "Mix.wav", mimeType: "audio/wav", buffer: tone });
    await page.getByTestId("match-confirm").click();
    await expect(mixRow.getByTestId("version-button")).toHaveText(
      new RegExp(`v${String(n)} / ${String(n)}`),
      { timeout: 60_000 },
    );
  }

  await mixRow.getByTestId("version-button").click();
  const stack = page.getByTestId("version-stack");
  await expect(stack.getByTestId("version-item")).toHaveCount(3, { timeout: 30_000 });
  await stack.getByTestId("versions-select").click();
  await stack.locator('[data-testid="version-item"][data-number="1"]').click();
  await stack.locator('[data-testid="version-item"][data-number="2"]').click();
  await expect(page.getByTestId("versions-selection-bar")).toContainText("2 selected");
  await page.getByTestId("versions-selection-bar").getByTestId("selection-delete").click();
  await expect(stack.getByTestId("version-item")).toHaveCount(1, { timeout: 30_000 });
  await page.keyboard.press("Escape");
  await expect(mixRow.getByTestId("version-button")).toHaveText(/v3/);

  await page.goto(`projects/${projectId}?tab=trash`);
  const trash = page.getByTestId("trash-row");
  await expect(trash).toHaveCount(2, { timeout: 30_000 });
  await trash.filter({ hasText: "Mix v1" }).getByTestId("trash-restore").click();
  await expect(trash).toHaveCount(1, { timeout: 30_000 });
});

test("selection bar and Trash fit a 360 px phone", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 360, height: 740 });
  await loginAsNewUser(page, page.request, testInfo, "member");
  const projectId = await projectWithSongs(page, `Narrow ${uniqueUsername(testInfo)}`, [
    "A song with a rather long title for a narrow phone",
    "Second",
  ]);
  await page.goto(`projects/${projectId}`);
  await page.getByTestId("songs-select").click();
  await page.getByTestId("selection-all").click();
  const del = page.getByTestId("selection-delete");
  await expect(del).toBeVisible();
  expect((await del.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(await noHorizontalScroll(page)).toBe(true);
  await del.click();
  await expect(page.getByTestId("song-row")).toHaveCount(0, { timeout: 30_000 });
  await page.goto(`projects/${projectId}?tab=trash`);
  await expect(page.getByTestId("trash-row")).toHaveCount(2, { timeout: 30_000 });
  expect(await noHorizontalScroll(page)).toBe(true);
  const restore = page.getByTestId("trash-restore").first();
  expect((await restore.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
});

test("a deleted project is restored from Admin → Trash", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await loginAsNewUser(page, page.request, testInfo, "admin");
  const name = `Gone ${uniqueUsername(testInfo)}`;
  const projectId = await projectWithSongs(page, name, ["Only song"]);
  const del = await page.request.delete(`api/v1/projects/${projectId}`, { headers: CSRF });
  expect(del.ok()).toBe(true);

  // Other tests share the server: find this project's row by its name.
  await page.goto("admin?tab=trash");
  const row = page.getByTestId("trash-row").filter({ hasText: name });
  await expect(row).toHaveCount(1, { timeout: 30_000 });
  await expect(row).toHaveAttribute("data-kind", "project");
  await row.getByTestId("trash-restore").click();
  await expect(row).toHaveCount(0, { timeout: 30_000 });

  // Back in the library with its song.
  await page.goto(`projects/${projectId}`);
  await expect(page.getByTestId("song-row")).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId("song-row")).toContainText("Only song");
});
