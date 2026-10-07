import { expect, test } from "@playwright/test";
import { AIFF_FILE, generateFixtures, TONE_FILE } from "@bandroom/fixtures";
import { isMobile, loginAsNewUser, uniqueUsername } from "./helpers";

test.beforeAll(async () => {
  await generateFixtures();
});

const CSRF = { "X-Requested-With": "bandroom" };

test("Export a project as a ZIP: preview, then the streamed archive (SPEC §28.7)", async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  await loginAsNewUser(page, page.request, testInfo, "member");
  await page.goto("library");
  await page.getByTestId("new-project").click();
  await page.getByLabel("Name").fill(`Export ${uniqueUsername(testInfo)}`);
  await page.getByTestId("create-project-submit").click();
  await page.getByTestId("project-settings-tab").waitFor();
  const projectUrl = page.url().replace(/\?.*$/, "");
  const projectId = projectUrl.split("/").pop() ?? "";
  await page.getByTestId("new-song").click();
  await page.getByLabel("Title", { exact: true }).fill("Two takes");
  await page.getByTestId("create-song-submit").click();
  await page.getByTestId("song-row").filter({ hasText: "Two takes" }).getByRole("link").click();
  await page
    .getByTestId("track-dropzone")
    .locator('input[type="file"]')
    .setInputFiles([TONE_FILE(), AIFF_FILE()]);
  const rows = page.getByTestId("track-row");
  await expect(rows.filter({ hasText: "kHz" })).toHaveCount(2, { timeout: 180_000 });
  const doc = await page.request.post(`api/v1/projects/${projectId}/documents`, {
    headers: CSRF,
    data: { title: "Setlist", kind: "text", text: "1. Two takes\n" },
  });
  expect(doc.ok()).toBe(true);

  await page.goto(projectUrl);
  await page.getByTestId("project-export").click();
  const dialog = page.getByTestId("export-dialog");
  await expect(dialog.getByTestId("export-summary")).toContainText("3 files in 1 song");
  if (isMobile(testInfo)) {
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      )
      .toBeLessThanOrEqual(0);
  }
  const href = (await dialog.getByTestId("export-download").getAttribute("href")) ?? "";
  expect(href).toMatch(/\/projects\/[^/]+\/export\/download\?format=flac$/);

  const res = await page.request.get(href);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("application/zip");
  const body = await res.body();
  expect(body.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  expect(body.length).toBe(Number(res.headers()["content-length"]));
  // End of central directory: three entries.
  expect(body.readUInt32LE(body.length - 22)).toBe(0x06054b50);
  expect(body.readUInt16LE(body.length - 22 + 10)).toBe(3);
});
