import { expect, test, type Page } from "@playwright/test";
import { AIFF_FILE, FLAC_FILE, generateFixtures, TONE_FILE } from "@bandroom/fixtures";
import { createUser, isMobile, loginAsNewUser, uniqueUsername, USER_PASSWORD } from "./helpers";

/**
 * M17: edit mode (SPEC §24.6, §24.7, §24.17 E2E): split, cut on all tracks, move a region to
 * another track, undo/redo, the session surviving a reload, a second editor who sees the banner,
 * is refused a frozen change, takes over and cancels; the remap preview moves a marker; phones
 * keep 44 px handles and no horizontal scroll.
 */

test.beforeAll(async () => {
  await generateFixtures();
});

const CSRF = { "X-Requested-With": "bandroom" };

interface DebugState {
  status: string;
  position: number;
  length: number;
  clipsPerTrack: Record<string, number>;
  edit: { sessionId: string; clipsPerTrack: Record<string, number> } | null;
}
const debug = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as { __bandroomRehearse?: { state: () => DebugState } }
      ).__bandroomRehearse?.state() ?? null,
  );
/** Clips per track in base (track) order. */
const clipCounts = async (page: Page) => {
  const s = await debug(page);
  return s?.edit ? Object.values(s.edit.clipsPerTrack) : null;
};

/** Scrolls the timeline to the middle of the screen (clear of the transport and the sheet). */
async function centerTimeline(page: Page) {
  await page.getByTestId("timeline-detail").evaluate((el) => {
    el.scrollIntoView({ block: "center" });
  });
}

/** The x (page px) of a time on the detail view. */
async function xOf(page: Page, sec: number): Promise<{ x: number; rulerY: number }> {
  const detail = page.getByTestId("timeline-detail");
  const box = await detail.boundingBox();
  const view = await detail.getAttribute("data-view");
  if (!box || !view) throw new Error("no timeline");
  const [from = 0, to = 1] = view.split(",").map(Number);
  return { x: box.x + ((sec - from) / (to - from)) * box.width, rulerY: box.y + 12 };
}

async function seekTo(page: Page, sec: number) {
  const { x, rulerY } = await xOf(page, sec);
  await page.mouse.click(x, rulerY);
  await expect
    .poll(async () => Math.abs(((await debug(page))?.position ?? 0) / 48_000 - sec))
    .toBeLessThan(0.1);
}

async function selectRange(page: Page, from: number, to: number) {
  const a = await xOf(page, from);
  const b = await xOf(page, to);
  await page.mouse.move(a.x, a.rulerY);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, a.rulerY, { steps: 4 });
  await page.mouse.move(b.x, b.rulerY, { steps: 4 });
  await page.mouse.up();
}

test("Edit mode: split, cut, move, undo/redo, reload, takeover and cancel", async ({
  page,
  browser,
  browserName,
  request,
}, testInfo) => {
  test.setTimeout(600_000);
  const phone = isMobile(testInfo);
  await loginAsNewUser(page, page.request, testInfo, "member");
  const res = await page.request.post("api/v1/projects", {
    headers: CSRF,
    data: { name: `Edit ${uniqueUsername(testInfo)}` },
  });
  const { project } = (await res.json()) as { project: { id: string } };
  const songRes = await page.request.post(`api/v1/projects/${project.id}/songs`, {
    headers: CSRF,
    data: { title: "Cut me" },
  });
  const { song } = (await songRes.json()) as { song: { id: string } };
  await page.request.post(`api/v1/songs/${song.id}/markers`, {
    headers: CSRF,
    data: { type: "marker", name: "Hit", color: "red", startSec: 6.5 },
  });
  await page.goto(`songs/${song.id}`);
  await page
    .getByTestId("track-dropzone")
    .locator('input[type="file"]')
    .setInputFiles([TONE_FILE(), AIFF_FILE(), FLAC_FILE()]);
  await expect(page.getByTestId("track-row")).toHaveCount(3, { timeout: 90_000 });
  await expect(page.getByTestId("edit-audio")).toBeEnabled({ timeout: 240_000 });
  // All three ingested (the button needs one).
  await expect
    .poll(
      async () =>
        (
          (await (await page.request.get(`api/v1/songs/${song.id}/tracks`)).json()) as {
            tracks: { current: { status: string } | null }[];
          }
        ).tracks.filter((t) => t.current?.status === "ready").length,
      { timeout: 240_000 },
    )
    .toBe(3);
  await page.reload();

  // Enter: the Mixer opens with the clips; the engine plays the session.
  await page.getByTestId("edit-audio").click();
  const toolbar = page.getByTestId("edit-toolbar");
  await expect(toolbar).toBeVisible();
  await expect(toolbar).toHaveAttribute("data-layout", phone ? "sheet" : "bar");
  await expect(page.getByTestId("edit-clip")).toHaveCount(3, { timeout: 90_000 });
  await expect.poll(async () => (await debug(page))?.edit?.sessionId ?? null).not.toBeNull();
  expect(await clipCounts(page)).toEqual([1, 1, 1]);
  // Version controls are hidden; the header has the edit bar.
  await expect(page.getByTestId("track-version")).toHaveCount(0);
  await expect(page.getByTestId("edit-bar")).toBeVisible();
  // Cut without a range says why.
  await expect(page.getByTestId("edit-cut")).toBeDisabled();

  // Split at the playhead (2 s) on every track.
  await centerTimeline(page);
  await seekTo(page, 2);
  await page.getByTestId("edit-split").click();
  await expect.poll(() => clipCounts(page)).toEqual([2, 2, 2]);

  // Cut 4–5 s on all tracks: ripple, the song is 1 s shorter and the marker moves from 0:06.5 to 0:05.5.
  await selectRange(page, 4, 5);
  await page.getByTestId("edit-cut").click();
  await expect.poll(() => clipCounts(page)).toEqual([3, 3, 3]);
  await expect
    .poll(async () => Math.abs(((await debug(page))?.length ?? 0) - 9 * 48_000))
    .toBeLessThan(0.05 * 48_000);
  await expect(page.getByTestId("marker-item")).toHaveAttribute("aria-label", /0:05/);

  // Move the first region of track 1 down to track 2 (a mouse drag on every device).
  await centerTimeline(page);
  const first = page.locator('[data-testid="edit-clip"]').first();
  const box = await first.boundingBox();
  if (!box) throw new Error("no clip");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.9, { steps: 4 });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 1.5, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => clipCounts(page)).toEqual([2, 4, 3]);

  // Undo and redo.
  await page.getByTestId("edit-undo").click();
  await expect.poll(() => clipCounts(page)).toEqual([3, 3, 3]);
  await page.getByTestId("edit-redo").click();
  await expect.poll(() => clipCounts(page)).toEqual([2, 4, 3]);

  // Picked regions get 44 px trim handles.
  await centerTimeline(page);
  const second = page.locator('[data-testid="edit-clip"]').nth(1);
  if (phone && browserName === "chromium") {
    // Touch: a long-press picks (Chromium's CDP touch events; WebKit has no touch input here).
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-picked]")).toHaveCount(0);
    const b = await second.boundingBox();
    if (!b) throw new Error("no clip");
    const cdp = await page.context().newCDPSession(page);
    const at = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] });
    await page.waitForTimeout(800);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(page.locator("[data-picked]")).toHaveCount(1);
  } else await second.click();
  const handles = page.getByTestId("clip-handle");
  await expect(handles.first()).toBeVisible();
  const hb = await handles.first().boundingBox();
  expect(hb?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(hb?.height ?? 0).toBeGreaterThanOrEqual(44);
  if (phone) {
    const [scrollW, innerW] = await page.evaluate(() => [
      document.documentElement.scrollWidth,
      window.innerWidth,
    ]);
    expect(scrollW).toBeLessThanOrEqual(innerW);
  }

  // Autosaved: a reload continues the session.
  await expect(page.getByTestId("edit-save-status")).toHaveAttribute("data-status", "saved", {
    timeout: 15_000,
  });
  const sessionId = (await debug(page))?.edit?.sessionId;
  await page.reload();
  await expect(page.getByTestId("edit-toolbar")).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => clipCounts(page), { timeout: 30_000 }).toEqual([2, 4, 3]);
  expect((await debug(page))?.edit?.sessionId).toBe(sessionId);

  // A second editor sees the banner, is refused a frozen change and takes over.
  const other = uniqueUsername(testInfo, "e");
  await createUser(request, other, "member");
  const ctx = await browser.newContext({ ...testInfo.project.use });
  const page2 = await ctx.newPage();
  await page2.request.post("api/v1/auth/login", {
    headers: CSRF,
    data: { login: other, password: USER_PASSWORD },
  });
  const me2 = (await (await page2.request.get("api/v1/auth/session")).json()) as {
    user: { id: string };
  };
  const grant = await page.request.put(`api/v1/projects/${project.id}/grants/${me2.user.id}`, {
    headers: CSRF,
    data: { role: "editor" },
  });
  expect(grant.ok()).toBe(true);
  await page2.goto(`songs/${song.id}`);
  await expect(page2.getByTestId("edit-banner")).toBeVisible({ timeout: 30_000 });
  await expect(page2.getByTestId("edit-audio")).toHaveCount(0);
  await expect(page2.getByTestId("add-marker")).toBeDisabled();
  const refused = await page2.request.post(`api/v1/songs/${song.id}/markers`, {
    headers: CSRF,
    data: { type: "marker", name: "Sneaky", color: "red", startSec: 1 },
  });
  expect(refused.status()).toBe(409);
  expect(((await refused.json()) as { code: string }).code).toBe("SONG_EDITING");
  // They hear the unedited song.
  await expect
    .poll(async () => {
      const s = await debug(page2);
      return s ? s.edit : "no player";
    })
    .toBeNull();

  await page2.getByTestId("edit-take-over").click();
  await page2.getByTestId("edit-session-confirm-ok").click();
  await expect(page2.getByTestId("edit-toolbar")).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => clipCounts(page2), { timeout: 30_000 }).toEqual([2, 4, 3]);
  // The first editor's page leaves edit mode and shows the banner.
  await expect(page.getByTestId("edit-banner")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("edit-toolbar")).toHaveCount(0);

  // Cancel (confirmed: the session has ops): the song is free again for both.
  await page2.getByTestId("edit-cancel").click();
  await page2.getByTestId("edit-cancel-confirm").click();
  await expect(page2.getByTestId("edit-toolbar")).toHaveCount(0);
  await expect(page2.getByTestId("edit-audio")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("edit-banner")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("edit-audio")).toBeVisible();
  await expect(page.getByTestId("add-marker")).toBeEnabled();
  await ctx.close();
});
