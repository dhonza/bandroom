import fs from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { BWF_FILE, FLAC_FILE, generateFixtures, TONE_FILE } from "@bandroom/fixtures";
import { loginAsNewUser, storedZip, uniqueUsername } from "./helpers";

test.beforeAll(async () => {
  await generateFixtures();
});

test("upload a WAV, watch it process live, and download an identical WAV", async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    !["chromium", "subpath-chromium"].includes(testInfo.project.name),
    "desktop Chromium, root and sub-path",
  );
  test.setTimeout(90_000);
  await loginAsNewUser(page, request, testInfo, "member");

  // Create a project and a song through the UI.
  await page.goto("library");
  await page.getByTestId("new-project").click();
  await page.getByLabel("Name").fill(`Uploads ${uniqueUsername(testInfo)}`);
  await page.getByTestId("create-project-submit").click();
  await page.getByTestId("project-settings-tab").waitFor();
  await page.getByTestId("new-song").click();
  await page.getByLabel("Title", { exact: true }).fill("Demo");
  await page.getByTestId("create-song-submit").click();
  await page.getByTestId("song-row").filter({ hasText: "Demo" }).getByRole("link").click();
  await expect(page.getByRole("heading", { level: 2, name: "Demo" })).toBeVisible();

  // Drop the file (the dropzone wraps a file input).
  await page.getByTestId("track-dropzone").locator('input[type="file"]').setInputFiles(BWF_FILE());
  const row = page.getByTestId("track-row").filter({ hasText: "bwf_48000_s24_chunks" });
  await expect(row).toBeVisible({ timeout: 20_000 });
  // Processing finishes via the worker; the page updates over SSE without a reload.
  await expect(row.getByText("48 kHz")).toBeVisible({ timeout: 60_000 });
  await expect(row.getByText("v1")).toBeVisible();

  await row.getByTestId("track-actions").click();
  const href = await page.getByTestId("download-wav").getAttribute("href");
  expect(href).toBeTruthy();
  const res = await page.request.get(new URL(href ?? "", page.url()).toString());
  expect(res.ok()).toBe(true);
  expect((await res.body()).equals(await fs.readFile(BWF_FILE()))).toBe(true);
});

test("a zip on a project makes a song per folder; a zip on a song goes through the match dialog", async ({
  page,
  request,
}, testInfo) => {
  test.skip(!["chromium", "iphone"].includes(testInfo.project.name), "Chromium and iPhone");
  test.setTimeout(90_000);
  await loginAsNewUser(page, request, testInfo, "member");
  const tone = await fs.readFile(TONE_FILE());
  const flac = await fs.readFile(FLAC_FILE());

  await page.goto("library");
  await page.getByTestId("new-project").click();
  await page.getByLabel("Name").fill(`Zip ${uniqueUsername(testInfo)}`);
  await page.getByTestId("create-project-submit").click();
  await page.getByTestId("project-settings-tab").waitFor();
  // The folder picker is hidden on iOS, which can only pick files (SPEC §28.1).
  await expect(page.getByTestId("project-upload-folder")).toHaveCount(
    testInfo.project.name === "iphone" ? 0 : 1,
  );
  // SPEC §28.1: one common top folder is stripped, each subfolder becomes a song.
  await page
    .getByTestId("folder-dropzone")
    .locator('input[type="file"]')
    .setInputFiles({
      name: "Gig.zip",
      mimeType: "application/zip",
      buffer: storedZip([
        { name: "Gig/Song A/Song A_bass.wav", data: tone },
        { name: "Gig/Song A/Song A_keys.flac", data: flac },
        { name: "Gig/Song B/gtr.wav", data: tone },
        { name: "__MACOSX/Gig/._gtr.wav", data: Buffer.from("x") },
      ]),
    });
  const rows = page.getByTestId("song-row");
  await expect(rows).toHaveCount(2, { timeout: 30_000 });
  await expect(rows.filter({ hasText: "Song B" })).toBeVisible();

  await rows.filter({ hasText: "Song A" }).getByRole("link").click();
  const tracks = page.getByTestId("track-row");
  await expect(tracks).toHaveCount(2, { timeout: 30_000 });
  await expect(tracks.filter({ hasText: "bass" })).toBeVisible();

  // On a song the zip's audio files are flattened into the match dialog.
  await page
    .getByTestId("track-dropzone")
    .locator('input[type="file"]')
    .setInputFiles({
      name: "takes.zip",
      mimeType: "application/zip",
      buffer: storedZip([
        { name: "takes/v2_bass.wav", data: tone },
        { name: "takes/deep/v2_drums.wav", data: tone },
      ]),
    });
  await expect(page.getByTestId("match-row")).toHaveCount(2);
  await page.getByTestId("match-confirm").click();
  await expect(tracks).toHaveCount(3, { timeout: 30_000 });
  await expect(tracks.filter({ hasText: "drums" })).toBeVisible();
});
