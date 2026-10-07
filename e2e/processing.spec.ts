import fs from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { generateFixtures, TONE_FILE } from "@bandroom/fixtures";
import { loginAsNewUser, uniqueUsername } from "./helpers";

const CSRF = { "X-Requested-With": "bandroom" };

test.beforeAll(async () => {
  await generateFixtures();
});

test("processing badges on the song list and in the header (SPEC §25.3)", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  await loginAsNewUser(page, request, testInfo, "member");
  const projectName = `Processing ${uniqueUsername(testInfo)}`;
  const res = await page.request.post("api/v1/projects", {
    headers: CSRF,
    data: { name: projectName },
  });
  const { project } = (await res.json()) as { project: { id: string } };
  const songRes = await page.request.post(`api/v1/projects/${project.id}/songs`, {
    headers: CSRF,
    data: { title: "Busy" },
  });
  const { song } = (await songRes.json()) as { song: { id: string } };

  // A real file and one that cannot be processed.
  await page.goto(`songs/${song.id}`);
  const input = page.getByTestId("track-dropzone").locator('input[type="file"]');
  await input.setInputFiles([
    { name: "tone.wav", mimeType: "audio/wav", buffer: await fs.readFile(TONE_FILE()) },
    { name: "broken.wav", mimeType: "audio/wav", buffer: Buffer.from("not really audio") },
  ]);
  await expect(page.getByTestId("track-row")).toHaveCount(2, { timeout: 30_000 });

  // The header shows the work (the files, then the automatic mix) and links to the song.
  const indicator = page.getByTestId("processing-indicator");
  await expect(indicator).toBeVisible({ timeout: 30_000 });
  await page.goto(`projects/${project.id}`);
  const badge = page.getByTestId("song-row").getByTestId("processing-badge");
  await expect(badge).toBeVisible();
  // The broken file fails for good: red wins over the rest.
  await expect(badge).toHaveAttribute("data-state", "failed", { timeout: 180_000 });
  await expect(badge).toHaveText("1 failed");

  if (await indicator.isVisible()) {
    await page.getByTestId("processing-button").click();
    // Members see every project's work (other tests run in parallel): pick this one.
    const item = page
      .getByTestId("processing-popover")
      .getByTestId("processing-song")
      .filter({ hasText: projectName });
    await expect(item).toContainText("Busy");
    await item.click();
    await expect(page).toHaveURL(new RegExp(`/songs/${song.id}$`));
  }

  // No horizontal overflow at 360 px with the badge and the indicator.
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto(`projects/${project.id}`);
  await expect(badge).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
