import { expect, test, type Page } from "@playwright/test";
import { generateFixtures, TONE_FILE } from "@bandroom/fixtures";
import { isMobile, loginAsNewUser, uniqueUsername } from "./helpers";

test.beforeAll(async () => {
  await generateFixtures();
});

const CSRF = { "X-Requested-With": "bandroom" };

/** The open panel fills the viewport (a full-screen modal, not a popover or a bottom sheet). */
async function expectFullScreen(page: Page) {
  const content = page
    .locator(".mantine-Modal-content")
    .filter({ has: page.getByTestId("practice-form") });
  await expect(content).toBeVisible();
  const size = page.viewportSize();
  expect(size).not.toBeNull();
  await expect
    .poll(async () => (await content.boundingBox())?.height ?? 0)
    .toBeGreaterThanOrEqual((size?.height ?? 0) - 2);
}

/** Changes the speed, then scrolls to Reset and taps it: the whole form can be reached. */
async function resetReachable(page: Page) {
  await page.getByTestId("practice-preset-75").click();
  await expect(page.getByTestId("practice-speed-value")).toHaveText("75 %");
  const reset = page.getByTestId("practice-reset");
  await reset.scrollIntoViewIfNeeded();
  await reset.click();
  await expect(page.getByTestId("practice-speed-value")).toHaveText("100 %");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("practice-form")).toBeHidden();
}

test("phones: the Practice panel is full screen, in portrait and landscape", async ({
  page,
}, testInfo) => {
  test.skip(!isMobile(testInfo), "phone layout only");
  test.setTimeout(300_000);
  await loginAsNewUser(page, page.request, testInfo, "member");
  const res = await page.request.post("api/v1/projects", {
    headers: CSRF,
    data: { name: `Panels ${uniqueUsername(testInfo)}` },
  });
  expect(res.ok()).toBe(true);
  const { project } = (await res.json()) as { project: { id: string } };
  const songRes = await page.request.post(`api/v1/projects/${project.id}/songs`, {
    headers: CSRF,
    data: { title: "Full screen" },
  });
  expect(songRes.ok()).toBe(true);
  const { song } = (await songRes.json()) as { song: { id: string } };

  await page.goto(`songs/${song.id}`);
  await page.getByTestId("track-dropzone").locator('input[type="file"]').setInputFiles(TONE_FILE());
  await expect(page.getByTestId("track-row").filter({ hasText: "kHz" })).toHaveCount(1, {
    timeout: 180_000,
  });

  // Portrait: the Practice button is always in row 2 of the control bar (SPEC §31.1).
  const phoneButton = page.getByTestId("practice-phone-button");
  await expect(phoneButton).toBeVisible({ timeout: 30_000 });
  await expect(phoneButton).toHaveAccessibleName("Practice");
  const box = await phoneButton.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(43.5);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(43.5);
  await phoneButton.click();
  await expectFullScreen(page);
  await resetReachable(page);

  // Landscape: the one-row bar's Practice button opens the same full-screen panel (SPEC §31.6).
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.getByTestId("rehearse-transport")).toHaveAttribute("data-layout", "landscape");
  const button = page.getByTestId("practice-phone-button");
  await button.scrollIntoViewIfNeeded();
  await button.click();
  await expectFullScreen(page);
  await resetReachable(page);
});
