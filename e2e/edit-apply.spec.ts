import { expect, test, type Page } from "@playwright/test";
import { AIFF_FILE, FLAC_FILE, generateFixtures, TONE_FILE } from "@bandroom/fixtures";
import { isMobile, loginAsNewUser, uniqueUsername } from "./helpers";

/**
 * M18: Apply and Bounce (SPEC §24.8, §24.9, §24.17 E2E): a cut on all tracks is applied →
 * new versions `ready`, the marker after the cut moved, the old versions in the Trash and one
 * restored; a split-into-songs bounce at two sections makes two songs with the chosen names;
 * the dialogs fit a 360 px phone without horizontal scroll.
 */

test.beforeAll(async () => {
  await generateFixtures();
});

const CSRF = { "X-Requested-With": "bandroom" };
/** Rendering and ingesting on a busy stack takes a while. */
const RENDER_TIMEOUT = 240_000;

interface DebugState {
  position: number;
  edit: { sessionId: string; clipsPerTrack: Record<string, number> } | null;
}
const debug = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as { __bandroomRehearse?: { state: () => DebugState } }
      ).__bandroomRehearse?.state() ?? null,
  );
const clipCounts = async (page: Page) => {
  const s = await debug(page);
  return s?.edit ? Object.values(s.edit.clipsPerTrack) : null;
};

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

async function xOf(page: Page, sec: number): Promise<{ x: number; rulerY: number }> {
  const detail = page.getByTestId("timeline-detail");
  const box = await detail.boundingBox();
  const view = await detail.getAttribute("data-view");
  if (!box || !view) throw new Error("no timeline");
  const [from = 0, to = 1] = view.split(",").map(Number);
  return { x: box.x + ((sec - from) / (to - from)) * box.width, rulerY: box.y + 12 };
}

async function centerTimeline(page: Page) {
  await page.getByTestId("timeline-detail").evaluate((el) => {
    el.scrollIntoView({ block: "center" });
  });
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

interface TrackDto {
  id: string;
  name: string;
  current: { id: string; number: number; status: string } | null;
}
const tracksOf = async (page: Page, songId: string) =>
  (
    (await (await page.request.get(`api/v1/songs/${songId}/tracks`)).json()) as {
      tracks: TrackDto[];
    }
  ).tracks;

/** A project with one song, its markers, and `files` uploaded and ingested. */
async function songWithTracks(
  page: Page,
  name: string,
  markers: Record<string, unknown>[],
  files: string[],
) {
  const res = await page.request.post("api/v1/projects", { headers: CSRF, data: { name } });
  const { project } = (await res.json()) as { project: { id: string } };
  const songRes = await page.request.post(`api/v1/projects/${project.id}/songs`, {
    headers: CSRF,
    data: { title: "Rehearsal" },
  });
  const { song } = (await songRes.json()) as { song: { id: string } };
  for (const m of markers) {
    const r = await page.request.post(`api/v1/songs/${song.id}/markers`, {
      headers: CSRF,
      data: { color: "red", ...m },
    });
    expect(r.ok()).toBe(true);
  }
  await page.goto(`songs/${song.id}`);
  await page.getByTestId("track-dropzone").locator('input[type="file"]').setInputFiles(files);
  await expect(page.getByTestId("track-row")).toHaveCount(files.length, { timeout: 90_000 });
  await expect
    .poll(
      async () =>
        (await tracksOf(page, song.id)).filter((t) => t.current?.status === "ready").length,
      { timeout: RENDER_TIMEOUT },
    )
    .toBe(files.length);
  await page.reload();
  return { projectId: project.id, songId: song.id };
}

async function enterEdit(page: Page, tracks: number) {
  await page.getByTestId("edit-audio").click();
  await expect(page.getByTestId("edit-toolbar")).toBeVisible();
  await expect(page.getByTestId("edit-clip")).toHaveCount(tracks, { timeout: 90_000 });
  await expect.poll(async () => (await debug(page))?.edit?.sessionId ?? null).not.toBeNull();
}

test("Apply: a cut on all tracks replaces the audio, moves the marker, old versions to Trash", async ({
  page,
}, testInfo) => {
  test.setTimeout(600_000);
  const phone = isMobile(testInfo);
  await loginAsNewUser(page, page.request, testInfo, "member");
  const { projectId, songId } = await songWithTracks(
    page,
    `Apply ${uniqueUsername(testInfo)}`,
    [{ type: "marker", name: "Hit", startSec: 6.5 }],
    [TONE_FILE(), AIFF_FILE(), FLAC_FILE()],
  );
  const before = await tracksOf(page, songId);
  await enterEdit(page, 3);

  // Nothing edited yet: Apply says why.
  await expect(page.getByTestId("edit-apply")).toBeDisabled();
  // Cut 4–5 s on all tracks.
  await centerTimeline(page);
  await selectRange(page, 4, 5);
  await page.getByTestId("edit-cut").click();
  await expect.poll(() => clipCounts(page)).toEqual([2, 2, 2]);
  await expect(page.getByTestId("marker-item")).toHaveAttribute("aria-label", /0:05/);

  // The review: three tracks 0:10 → 0:09, the marker moves, the old audio goes to the Trash.
  await page.getByTestId("edit-apply").click();
  const dialog = page.getByTestId("edit-apply-dialog");
  await expect(dialog.getByTestId("edit-review-track")).toHaveCount(3, { timeout: 30_000 });
  // The mouse selection can land a few ms wider than 4–5 s (WebKit), so 0:08.9… shows as 0:08.
  await expect(dialog.getByTestId("edit-review-track").first()).toContainText(/0:10 → 0:0[89]/);
  await expect(dialog.getByTestId("edit-review-timeline")).toContainText("1 marker moved");
  await expect(dialog.getByTestId("edit-review-size")).toBeVisible();
  await expect(dialog).toContainText("Trash");
  if (phone) expect(await noHorizontalScroll(page)).toBe(true);
  await dialog.getByTestId("edit-apply-confirm").click();

  // Read-only while it renders, then edit mode ends with a toast.
  await expect(page.getByTestId("edit-apply-dialog")).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId("edit-finished")).toContainText("Applied to 3 tracks", {
    timeout: RENDER_TIMEOUT,
  });
  await expect(page.getByTestId("edit-toolbar")).toHaveCount(0);
  await expect(page.getByTestId("edit-audio")).toBeVisible({ timeout: 30_000 });

  // New current versions, ready; the marker moved from 6.5 s to 5.5 s.
  const after = await tracksOf(page, songId);
  expect(after.map((t) => t.current?.status)).toEqual(["ready", "ready", "ready"]);
  for (const t of after) {
    const old = before.find((b) => b.id === t.id);
    expect(t.current?.id).not.toBe(old?.current?.id);
  }
  const markers = (
    (await (await page.request.get(`api/v1/songs/${songId}/markers`)).json()) as {
      markers: { name: string; startSec: number }[];
    }
  ).markers;
  expect(markers.find((m) => m.name === "Hit")?.startSec ?? 0).toBeCloseTo(5.5, 1);
  await expect(page.getByTestId("marker-item")).toHaveAttribute("aria-label", /0:05/);

  // The replaced versions are in the Trash; restore one.
  await page.goto(`projects/${projectId}?tab=trash`);
  const trash = page.getByTestId("trash-row");
  await expect(trash).toHaveCount(3, { timeout: 30_000 });
  await trash.first().getByTestId("trash-restore").click();
  await expect(trash).toHaveCount(2, { timeout: 30_000 });
});

test("Bounce: split into songs at two sections with chosen names", async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  const phone = isMobile(testInfo);
  await loginAsNewUser(page, page.request, testInfo, "member");
  const { projectId } = await songWithTracks(
    page,
    `Split ${uniqueUsername(testInfo)}`,
    [
      { type: "section", name: "Intro", startSec: 0, endSec: 4 },
      { type: "section", name: "Verse", startSec: 4, endSec: 9 },
    ],
    [TONE_FILE(), FLAC_FILE()],
  );
  await enterEdit(page, 2);

  // Some edit first: silence 7–8 s on both tracks.
  await centerTimeline(page);
  await selectRange(page, 7, 8);
  await page.getByTestId("edit-silence").click();
  await expect.poll(() => clipCounts(page)).toEqual([2, 2]);

  // Phones: Bounce… is in the edit row's ⋯ (SPEC §31.2).
  if (isMobile(testInfo)) await page.getByTestId("edit-more").click();
  await page.getByTestId("edit-bounce").click();
  const dialog = page.getByTestId("edit-bounce-dialog");
  await dialog.getByTestId("edit-bounce-kind-bounceSongs").click();
  await expect(dialog.getByTestId("edit-bounce-range")).toHaveCount(2, { timeout: 30_000 });
  await dialog.getByTestId("edit-bounce-numbered").click();
  const titles = dialog.getByTestId("edit-bounce-song-title");
  await expect(titles).toHaveCount(2);
  await expect(titles.nth(0)).toHaveValue("01 Intro");
  await expect(titles.nth(1)).toHaveValue("02 Verse");
  await titles.nth(0).fill("Opening");
  // The review lists one row per new song.
  await expect(dialog.getByTestId("edit-review-track")).toHaveCount(2, { timeout: 30_000 });
  if (phone) expect(await noHorizontalScroll(page)).toBe(true);
  await expect(dialog.getByTestId("edit-bounce-confirm")).toHaveText(/Make 2 songs/);
  await expect(dialog.getByTestId("edit-bounce-confirm")).toBeEnabled({ timeout: 30_000 });
  await dialog.getByTestId("edit-bounce-confirm").click();

  await expect(page.getByTestId("edit-finished")).toContainText("Created 2 songs", {
    timeout: RENDER_TIMEOUT,
  });
  await page.getByTestId("edit-open-project").click();
  await expect(page).toHaveURL(new RegExp(`projects/${projectId}`));
  const rows = page.getByTestId("song-row");
  await expect(rows).toHaveCount(3, { timeout: 30_000 });
  await expect(rows.filter({ hasText: "Opening" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "02 Verse" })).toHaveCount(1);
});
