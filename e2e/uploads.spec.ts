import fs from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { BWF_FILE, generateFixtures } from "@bandroom/fixtures";
import { loginAsNewUser, uniqueUsername } from "./helpers";

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
