import { expect, test, type Page } from "@playwright/test";
import { generateFixtures, TONE_FILE } from "@bandroom/fixtures";
import { isMobile, loginAsNewUser, openMixer, TAP_NAME, uniqueUsername } from "./helpers";

test.beforeAll(async () => {
  await generateFixtures();
});

const CSRF = { "X-Requested-With": "bandroom" };
/** CLAUDE.md / SPEC §11: touch targets are at least 44 px. Half a pixel absorbs rounding. */
const MIN = 43.5;

interface SmallTarget {
  what: string;
  width: number;
  height: number;
}

/**
 * Visible buttons, links and tabs smaller than 44 px in either direction. Links inside running
 * text are exempt (WCAG 2.5.8 inline exception).
 */
function smallTargets(page: Page): Promise<SmallTarget[]> {
  return page.evaluate((min) => {
    const out: SmallTarget[] = [];
    const nodes = document.querySelectorAll<HTMLElement>(
      'button, a[href], [role="button"], [role="tab"]',
    );
    for (const el of nodes) {
      if (el.closest('[aria-hidden="true"], [inert]')) continue;
      const style = getComputedStyle(el);
      if (style.visibility !== "visible" || style.display === "none") continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (el.tagName === "A" && el.closest("p, li, td, blockquote")) continue;
      if (r.width >= min && r.height >= min) continue;
      const label =
        el.dataset.testid ??
        el.getAttribute("aria-label") ??
        (el.textContent || "").trim().slice(0, 30);
      out.push({
        what: `${el.tagName.toLowerCase()} "${label}"`,
        width: Math.round(r.width),
        height: Math.round(r.height),
      });
    }
    return out;
  }, MIN);
}

async function expectTouchFriendly(page: Page, screen: string) {
  // Polled, so entering transitions (modals, sheets) can settle; a failure lists the offenders.
  // Soft, so one run reports every screen.
  await expect.soft
    .poll(() => smallTargets(page), { message: `small touch targets on ${screen}`, timeout: 5_000 })
    .toEqual([]);
}

expect.configure({ timeout: 20_000 });

test("Touch targets: buttons and links are at least 44 px on the main screens at 360 px", async ({
  page,
}, testInfo) => {
  test.skip(!isMobile(testInfo), "phone layout only");
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 360, height: 780 });

  await page.goto("login");
  await expect(page.getByRole("textbox", { name: "Password" })).toBeVisible();
  await expectTouchFriendly(page, "login");

  await loginAsNewUser(page, page.request, testInfo, "member");
  const res = await page.request.post("api/v1/projects", {
    headers: CSRF,
    data: { name: `Touch ${uniqueUsername(testInfo)}` },
  });
  expect(res.ok()).toBe(true);
  const { project } = (await res.json()) as { project: { id: string } };
  const songRes = await page.request.post(`api/v1/projects/${project.id}/songs`, {
    headers: CSRF,
    data: { title: "Small fingers" },
  });
  expect(songRes.ok()).toBe(true);
  const { song } = (await songRes.json()) as { song: { id: string } };
  const comment = await page.request.post(`api/v1/songs/${song.id}/comments`, {
    headers: CSRF,
    data: { body: "Loop this bit", startSec: 0.5, endSec: 1.5 },
  });
  expect(comment.ok()).toBe(true);

  await page.goto("library");
  await expect(page.getByTestId("new-project")).toBeVisible();
  await expectTouchFriendly(page, "library");

  await page.goto(`projects/${project.id}`);
  await expect(page.getByTestId("song-row")).toHaveCount(1);
  await expectTouchFriendly(page, "project");

  await page.goto(`songs/${song.id}`);
  await page.getByTestId("track-dropzone").locator('input[type="file"]').setInputFiles(TONE_FILE());
  const rows = page.getByTestId("track-row");
  await expect(rows.filter({ hasText: "kHz" })).toHaveCount(1, { timeout: 180_000 });
  await expectTouchFriendly(page, "song");

  await page.getByTestId("open-comments").click();
  await expect(page.getByTestId("comments-panel").getByTestId("comment-item")).toHaveCount(1);
  await expectTouchFriendly(page, "comments panel");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("comments-panel")).toBeHidden();

  await rows.getByTestId("version-button").click();
  await expect(page.getByTestId("version-item")).toHaveCount(1);
  await expectTouchFriendly(page, "version stack");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("version-item")).toHaveCount(0);

  await openMixer(page);
  await expectTouchFriendly(page, "mixer");
  await page.getByTestId("track-settings").click(TAP_NAME);
  await expect(page.getByTestId("track-settings-panel")).toBeVisible();
  await expectTouchFriendly(page, "track settings");
});
