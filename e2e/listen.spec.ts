import { expect, test } from "@playwright/test";
import { generateFixtures, TONE_FILE } from "@bandroom/fixtures";
import { closeMixer, loginAsNewUser, uniqueUsername } from "./helpers";

test.beforeAll(async () => {
  await generateFixtures();
});

test("folder drop, Play all, timeline seek, mini-player, versions", async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    !["chromium", "subpath-chromium"].includes(testInfo.project.name),
    "desktop Chromium, root and sub-path",
  );
  test.setTimeout(180_000);
  await loginAsNewUser(page, request, testInfo, "member");

  await page.goto("library");
  await page.getByTestId("new-project").click();
  await page.getByLabel("Name").fill(`Listen ${uniqueUsername(testInfo)}`);
  await page.getByTestId("create-project-submit").click();
  await page.getByTestId("project-settings-tab").waitFor();

  // A loose file dropped on the project becomes a song with one mix track.
  await page
    .getByTestId("folder-dropzone")
    .locator('input[type="file"]')
    .setInputFiles(TONE_FILE());
  const songRow = page.getByTestId("song-row").filter({ hasText: "tone_48000_s16_stereo" });
  await expect(songRow).toBeVisible({ timeout: 20_000 });

  // Play all → the mix plays once it is processed (until then the song opens with the Mixer).
  await songRow.getByRole("link").click();
  await closeMixer(page);
  const panel = page.getByTestId("listen-panel");
  // One worker processes every test's uploads (and the import spec's files) on this server.
  await expect(panel.getByTestId("listen-play")).toBeEnabled({ timeout: 120_000 });
  await expect(page.getByTestId("timeline")).toBeVisible();
  await panel.getByTestId("listen-play").click();
  await expect(panel.getByRole("button", { name: "Pause", exact: true })).toBeVisible({
    timeout: 15_000,
  });

  // Low quality while playing: the source switches and playback continues.
  await panel.getByTestId("listen-quality").click();
  await page.getByRole("menuitem", { name: "Low (saves mobile data)" }).click();
  await expect(panel.getByTestId("listen-quality")).toHaveAccessibleName("Quality: Low");
  await expect(panel.getByRole("button", { name: "Pause", exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await panel.getByTestId("listen-repeat").click();
  await expect(panel.getByTestId("listen-repeat")).toHaveAccessibleName("Repeat all songs");

  // Tap the detail timeline near the end → position jumps (song is 10 s long).
  const detail = page.getByTestId("timeline-detail");
  const box = await detail.boundingBox();
  if (!box) throw new Error("no timeline");
  await detail.click({ position: { x: box.width * 0.8, y: box.height / 2 } });
  await expect
    .poll(async () =>
      Number(
        (await page.getByTestId("listen-position").textContent())?.split(":")[1]?.split(".")[0] ??
          0,
      ),
    )
    .toBeGreaterThanOrEqual(7);

  // Leaving the song (in-app navigation, not a reload) shows the persistent mini-player.
  await page.getByTestId("desktop-nav").getByRole("link", { name: "Library" }).click();
  const mini = page.getByTestId("mini-player");
  await expect(mini).toBeVisible();
  await expect(mini).toContainText("tone_48000_s16_stereo");
  await mini.getByTestId("mini-play").click();
  await expect(mini.getByRole("button", { name: "Play", exact: true })).toBeVisible();

  // Back on the song: upload a second file → the match dialog proposes a new version of "Mix".
  await page.goBack();
  await page
    .getByTestId("track-dropzone")
    .locator('input[type="file"]')
    .setInputFiles({
      name: "Mix.wav",
      mimeType: "audio/wav",
      buffer: await (await import("node:fs/promises")).readFile(TONE_FILE()),
    });
  await expect(page.getByTestId("match-row")).toContainText("Mix.wav");
  await page.getByTestId("match-confirm").click();
  const mixRow = page.getByTestId("track-row").filter({ hasText: "Mix" });
  await expect(mixRow.getByTestId("version-button")).toHaveText(/v2 \/ 2/, { timeout: 30_000 });

  // Version stack: make v1 current again.
  await mixRow.getByTestId("version-button").click();
  const stack = page.getByTestId("version-stack");
  await expect(stack.getByTestId("version-item")).toHaveCount(2);
  await stack
    .locator('[data-testid="version-item"][data-number="1"]')
    .getByTestId("make-current")
    .click();
  await expect(stack.locator('[data-testid="version-item"][data-number="1"]')).toContainText(
    "current",
  );

  // Deleting the playing song stops it: the mini-player does not take over on the project page.
  await page.keyboard.press("Escape");
  await expect(stack).toBeHidden();
  await panel.getByTestId("listen-play").click();
  await expect(panel.getByRole("button", { name: "Pause", exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByTestId("delete-song").click();
  await page.getByTestId("confirm-name").fill("tone_48000_s16_stereo");
  await page.getByTestId("confirm-delete").click();
  await expect(page).toHaveURL(/projects\//, { timeout: 15_000 });
  await expect(page.getByText("The song was deleted, so playback stopped.")).toBeVisible();
  await expect(mini).toBeHidden();
});
