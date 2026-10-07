import AxeBuilder from "@axe-core/playwright";
import { generateFixtures, TONE_FILE } from "@bandroom/fixtures";
import { expect, test, type Page } from "@playwright/test";
import { ADMIN, apiLogin, loginAsNewUser, uniqueUsername } from "./helpers";

/**
 * Automated accessibility scan (axe-core) of the main screens: serious and critical WCAG 2.1 A/AA
 * violations fail. Runs in desktop Chromium and the Pixel phone layout; axe results do not depend
 * on the engine, and the other projects would only repeat them.
 */

test.beforeAll(async () => {
  await generateFixtures();
});

const CSRF = { "X-Requested-With": "bandroom" };

interface Finding {
  rule: string;
  impact: string | null | undefined;
  targets: string[];
}

async function seriousViolations(page: Page): Promise<Finding[]> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => ({
      rule: v.id,
      impact: v.impact,
      targets: v.nodes.slice(0, 5).map((n) => n.target.join(" ")),
    }));
}

/**
 * Polled, so entering transitions (drawers, modals fading in) can settle; soft, so one run reports
 * every screen. A failure lists the rules and their first nodes.
 */
async function expectAccessible(page: Page, screen: string) {
  await expect.soft
    .poll(() => seriousViolations(page), {
      message: `axe violations on ${screen}`,
      timeout: 10_000,
    })
    .toEqual([]);
}

expect.configure({ timeout: 20_000 });

test("Accessibility: the main screens have no serious or critical axe violations", async ({
  page,
}, testInfo) => {
  test.skip(
    !["chromium", "pixel"].includes(testInfo.project.name),
    "axe runs in desktop Chromium and the Pixel layout",
  );
  test.setTimeout(300_000);

  await page.goto("login");
  await expect(page.getByRole("textbox", { name: "Password" })).toBeVisible();
  await expectAccessible(page, "login");

  await loginAsNewUser(page, page.request, testInfo, "member");
  const res = await page.request.post("api/v1/projects", {
    headers: CSRF,
    data: { name: `A11y ${uniqueUsername(testInfo)}` },
  });
  expect(res.ok()).toBe(true);
  const { project } = (await res.json()) as { project: { id: string } };
  const songRes = await page.request.post(`api/v1/projects/${project.id}/songs`, {
    headers: CSRF,
    data: { title: "Readable" },
  });
  expect(songRes.ok()).toBe(true);
  const { song } = (await songRes.json()) as { song: { id: string } };
  const comment = await page.request.post(`api/v1/songs/${song.id}/comments`, {
    headers: CSRF,
    data: { body: "Check the bridge", startSec: 0.5 },
  });
  expect(comment.ok()).toBe(true);

  await page.goto("library");
  await expect(page.getByTestId("new-project")).toBeVisible();
  await expectAccessible(page, "library");

  await page.goto(`projects/${project.id}`);
  await expect(page.getByTestId("song-row")).toHaveCount(1);
  await expectAccessible(page, "project");

  await page.goto(`songs/${song.id}`);
  await page.getByTestId("track-dropzone").locator('input[type="file"]').setInputFiles(TONE_FILE());
  await expect(page.getByTestId("track-row").filter({ hasText: "kHz" })).toHaveCount(1, {
    timeout: 180_000,
  });
  await expectAccessible(page, "song");

  await page.getByTestId("open-comments").click();
  await expect(page.getByTestId("comments-panel").getByTestId("comment-item")).toHaveCount(1);
  await expectAccessible(page, "comments panel");
  await page.keyboard.press("Escape");

  await page.goto("notifications");
  await expect(page.getByRole("heading", { level: 2 })).toBeVisible();
  await expectAccessible(page, "notifications");

  await page.goto("settings");
  await expect(page.getByRole("heading", { level: 2 })).toBeVisible();
  await expectAccessible(page, "settings");

  // Admin screens, as the bootstrap admin.
  await apiLogin(page.request, ADMIN.username, ADMIN.password);
  await page.goto("admin");
  await expect(page.getByRole("heading", { level: 2 })).toBeVisible();
  await expectAccessible(page, "admin");
});
