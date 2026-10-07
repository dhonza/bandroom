import fs from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { generateFixtures, TONE_FILE } from "@bandroom/fixtures";
import {
  apiLogin,
  createUser,
  isMobile,
  loginAsNewUser,
  openMixer,
  uniqueUsername,
  USER_PASSWORD,
} from "./helpers";

test.beforeAll(async () => {
  await generateFixtures();
});

interface DebugState {
  status: string;
  position: number;
  length: number;
  loop: { start: number; end: number } | null;
}

const debug = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as { __bandroomRehearse?: { state: () => DebugState } }
      ).__bandroomRehearse?.state() ?? null,
  );

/** Scrolls the detail timeline to the middle of the viewport (the header is fixed). */
async function centerTimeline(page: Page) {
  await page.getByTestId("timeline-detail").evaluate((el) => {
    el.scrollIntoView({ block: "center", behavior: "instant" });
  });
}

/** A point on the detail timeline's waveform area at a fraction of its width. */
async function lanePoint(page: Page, fraction: number) {
  await centerTimeline(page);
  const box = await page.getByTestId("timeline-detail").boundingBox();
  if (!box) throw new Error("no timeline");
  return { x: box.x + box.width * fraction, y: box.y + box.height - 12 };
}

async function dragRuler(page: Page, a: number, b: number) {
  await centerTimeline(page);
  const box = await page.getByTestId("timeline-detail").boundingBox();
  if (!box) throw new Error("no timeline");
  const y = box.y + 10;
  await page.mouse.move(box.x + box.width * a, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * ((a + b) / 2), y, { steps: 4 });
  await page.mouse.move(box.x + box.width * b, y, { steps: 4 });
  await page.mouse.up();
}

async function noHorizontalOverflow(page: Page) {
  // Canvases and layout follow a viewport change on the next resize observation.
  await expect
    .poll(() => page.evaluate(() => window.innerWidth === document.documentElement.clientWidth))
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(0);
}

test("Comments: a mention at the playhead reaches another user live, with a notification", async ({
  page,
  browser,
  request,
  baseURL,
}, testInfo) => {
  test.setTimeout(300_000);
  const phone = isMobile(testInfo);
  await loginAsNewUser(page, request, testInfo, "member");
  const other = uniqueUsername(testInfo, "b");
  await createUser(request, other, "member");

  // A song with one processed track.
  await page.goto("library");
  await page.getByTestId("new-project").click();
  await page.getByLabel("Name").fill(`Comments ${uniqueUsername(testInfo)}`);
  await page.getByTestId("create-project-submit").click();
  await page.getByTestId("project-settings-tab").waitFor();
  await page.getByTestId("new-song").click();
  await page.getByLabel("Title", { exact: true }).fill("Talk about it");
  await page.getByTestId("create-song-submit").click();
  await page.getByTestId("song-row").filter({ hasText: "Talk about it" }).getByRole("link").click();
  await page.getByTestId("track-dropzone").locator('input[type="file"]').setInputFiles(TONE_FILE());
  const rows = page.getByTestId("track-row");
  await expect(rows).toHaveCount(1, { timeout: 20_000 });
  await expect(rows.filter({ hasText: "kHz" })).toHaveCount(1, { timeout: 180_000 });
  const songPath = new URL(page.url()).pathname;

  // The other member opens the same song and stays there.
  const ctxB = await browser.newContext({ ...testInfo.project.use, baseURL });
  const pageB = await ctxB.newPage();
  await apiLogin(pageB.request, other, USER_PASSWORD);
  await pageB.goto(songPath);
  await expect(pageB.getByRole("heading", { level: 2, name: "Talk about it" })).toBeVisible();
  await expect(pageB.getByTestId("timeline-detail")).toBeVisible({ timeout: 30_000 });
  await expect(pageB.getByTestId("comment-pin")).toHaveCount(0);

  // A seeks to ~40 % in Rehearse mode and comments at the playhead, mentioning B.
  await openMixer(page);
  await expect.poll(async () => (await debug(page))?.status, { timeout: 30_000 }).toBe("stopped");
  const at = await lanePoint(page, 0.4);
  await page.mouse.click(at.x, at.y);
  await expect
    .poll(async () => {
      const d = await debug(page);
      return d ? d.position / d.length : 0;
    })
    .toBeGreaterThan(0.3);
  const d0 = await debug(page);
  if (!d0) throw new Error("no engine");
  const expectedSec = d0.position / 48_000;
  await page.getByTestId("comment-at-playhead").click();
  const panel = page.getByTestId("comments-panel");
  await expect(panel.getByTestId("comment-composer")).toBeVisible();
  const input = panel.getByTestId("comment-input");
  await input.fill(`@${other.slice(0, 3)}`);
  await panel
    .getByTestId("mention-option")
    .filter({ hasText: `@${other}` })
    .click();
  await expect(input).toHaveValue(`@${other} `);
  await input.pressSequentially("check the **bass** here");
  await panel.getByTestId("comment-input-submit").click();
  const mine = panel.getByTestId("comment-item");
  await expect(mine).toHaveCount(1);
  await expect(mine.getByTestId("comment-mention")).toHaveText(`@${other}`);
  await expect(mine.locator("strong")).toHaveText("bass");
  const timeText = await mine.getByTestId("comment-time").textContent();
  const [m, s] = (timeText ?? "").split(":").map(Number);
  expect(Math.abs((m ?? 0) * 60 + (s ?? 0) - expectedSec)).toBeLessThan(1.5);

  // B sees the pin and the badge without reloading (SSE).
  await expect(pageB.getByTestId("comment-pin")).toHaveCount(1, { timeout: 20_000 });
  await expect(pageB.getByTestId("notification-badge").first()).toHaveAttribute("data-count", "1", {
    timeout: 20_000,
  });
  await pageB.getByTestId("open-comments").click();
  const panelB = pageB.getByTestId("comments-panel");
  await expect(panelB.getByTestId("comment-item")).toContainText("check the bass here");
  await pageB.keyboard.press("Escape");

  // B opens the notification: it deep-links to the song with the comment highlighted.
  await pageB.getByTestId("notification-bell").click();
  const note = pageB.getByTestId("notification");
  await expect(note).toHaveCount(1);
  await expect(note).toHaveAttribute("data-unread", "true");
  await expect(note).toContainText("mentioned you in Talk about it");
  await note.click();
  await expect(pageB).toHaveURL(new RegExp(`${songPath}$`), { timeout: 20_000 });
  await expect(
    pageB.getByTestId("comments-panel").locator('[data-testid="comment-item"][data-highlighted]'),
  ).toHaveCount(1, { timeout: 20_000 });
  await expect(pageB.getByTestId("notification-badge").first()).toHaveAttribute("data-count", "0");
  if (phone) await noHorizontalOverflow(pageB);
  await ctxB.close();

  // --- A: range comment from the selection, "Loop this", reply, reaction, resolve, delete. ---
  await page.keyboard.press("Escape");
  const closePanel = async () => {
    const close = page.getByTestId("comments-close");
    // The drawer may already be closing (animation), which detaches the button.
    if (await close.isVisible()) await close.click({ timeout: 5_000 }).catch(() => undefined);
    await expect(close).toBeHidden();
  };
  await closePanel();
  await dragRuler(page, 0.1, 0.3);
  await expect(page.getByTestId("selection")).toBeVisible();
  await page.getByTestId("comment-at-playhead").click();
  await expect(panel.getByTestId("composer-range")).toBeChecked();
  await panel.getByTestId("comment-input").fill("Range note");
  await panel.getByTestId("comment-input-submit").click();
  const range = panel.getByTestId("comment-item").filter({ hasText: "Range note" });
  await expect(range).toBeVisible();
  await closePanel();
  await page.getByTestId("selection-clear").click();
  await expect.poll(async () => (await debug(page))?.loop ?? null).toBeNull();
  await page.getByTestId("open-comments").click();
  await range.getByTestId("comment-loop").click();
  await expect.poll(async () => (await debug(page))?.loop ?? null).not.toBeNull();
  const loop = (await debug(page))?.loop;
  const len = (await debug(page))?.length ?? 1;
  expect((loop?.start ?? 0) / len).toBeGreaterThan(0.05);
  expect((loop?.end ?? 0) / len).toBeLessThan(0.35);

  const first = panel.getByTestId("comment-item").filter({ hasText: "check the bass here" });
  await first.getByTestId("comment-reply").click();
  await first.getByTestId("comment-reply-input").fill("Answering myself");
  await first.getByTestId("comment-reply-input-submit").click();
  await expect(first).toContainText("Answering myself");
  await first.getByTestId("comment-react").first().click();
  await page.getByTestId("reaction-option").first().click();
  await expect(first.getByTestId("comment-reaction").first()).toHaveText("👍 1");

  await range.getByTestId("comment-resolve").click();
  await expect(panel.getByTestId("comment-item").filter({ hasText: "Range note" })).toHaveCount(0);
  await panel.getByTestId("filter-resolved").click();
  await expect(range.getByTestId("comment-resolved-badge")).toBeVisible();

  await range.getByTestId("comment-menu").click();
  await page.getByTestId("comment-delete").click();
  await expect(panel.getByTestId("comment-item").filter({ hasText: "Range note" })).toHaveCount(0);
  await page.getByTestId("comment-undo").click();
  await expect(panel.getByTestId("comment-item").filter({ hasText: "Range note" })).toHaveCount(1);

  // Export as CSV.
  await panel.getByTestId("comments-export").click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-csv").click(),
  ]);
  const csv = await fs.readFile(await download.path(), "utf8");
  expect(csv).toContain("check the **bass** here");
  expect(csv).toContain("Range note");
  expect(csv).toContain("Answering myself");
  if (phone) {
    // The smallest supported phone width (SPEC §11): song page, panel and notifications.
    await page.setViewportSize({ width: 360, height: 740 });
    await noHorizontalOverflow(page);
    await closePanel();
    await noHorizontalOverflow(page);
    await page.goto("notifications");
    await expect(page.getByRole("heading", { level: 2, name: "Notifications" })).toBeVisible();
    await noHorizontalOverflow(page);
  }
});
