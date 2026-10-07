import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { generateFixtures, TONE_FILE } from "@bandroom/fixtures";
import { isMobile, loginAsNewUser, TAP_NAME, uniqueUsername } from "./helpers";

test.beforeAll(async () => {
  await generateFixtures();
});

/** Engine state exposed by the Rehearse controller (SPEC §20: debug state for e2e). */
const engine = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __bandroomRehearse?: { state: () => { status: string; position: number } };
        }
      ).__bandroomRehearse?.state() ?? null,
  );

async function newProject(page: Page, testInfo: TestInfo): Promise<void> {
  await page.goto("library");
  await page.getByTestId("new-project").click();
  await page.getByLabel("Name").fill(`Player ${uniqueUsername(testInfo)}`);
  await page.getByTestId("create-project-submit").click();
  await page.getByTestId("project-settings-tab").waitFor();
}

async function newSong(page: Page, title: string): Promise<void> {
  await page.getByTestId("new-song").click();
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page.getByTestId("create-song-submit").click();
  await page.getByTestId("song-row").filter({ hasText: title }).getByRole("link").click();
}

/** A song with one processed track (10 s tone), opened with the Mixer closed. */
async function songWithTrack(page: Page, testInfo: TestInfo): Promise<void> {
  await newProject(page, testInfo);
  await newSong(page, "One player");
  await page.getByTestId("track-dropzone").locator('input[type="file"]').setInputFiles(TONE_FILE());
  // One worker processes every test's uploads on this server, so under full-suite load this can
  // take minutes.
  await expect(page.getByTestId("rehearse-panel").getByTestId("rehearse-play")).toBeEnabled({
    timeout: 420_000,
  });
  await expect(page.getByTestId("mixer-toggle")).toHaveAttribute("aria-pressed", "false");
}

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error("not visible");
  return b;
}

async function noHorizontalOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(0);
}

test("one Player: one waveform with the Mixer closed; toggling moves nothing above the lanes", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(540_000);
  await loginAsNewUser(page, request, testInfo, "member");
  await songWithTrack(page, testInfo);
  const toggle = page.getByTestId("mixer-toggle");
  const panel = page.getByTestId("rehearse-panel");
  const timeline = panel.getByTestId("timeline");
  const overview = panel.getByTestId("timeline-overview");
  const transport = page.getByTestId("rehearse-transport");

  // Mixer closed: the overview strip is the only waveform (80 px by default), no track lanes.
  await expect(timeline).toHaveAttribute("data-lanes", "0");
  await expect(timeline).toHaveAttribute("data-overview-height", "80");
  await expect(panel.getByTestId("track-strip")).toHaveCount(0);
  await expect(panel.getByTestId("track-headers")).toHaveCount(0);
  expect(Math.round((await box(overview)).height)).toBe(80);
  // The transport sits above the overview, with count-in and click (desktop) or in "⋯" (phones).
  expect((await box(transport)).y).toBeLessThan((await box(overview)).y);
  if (!isMobile(testInfo)) await expect(page.getByTestId("click-toggle")).toBeVisible();

  const before = {
    toggle: await box(toggle),
    transport: await box(transport),
    overview: await box(overview),
  };
  const same = async () => {
    const now = {
      toggle: await box(toggle),
      transport: await box(transport),
      overview: await box(overview),
    };
    for (const k of ["toggle", "transport", "overview"] as const) {
      expect(Math.abs(now[k].x - before[k].x), k).toBeLessThanOrEqual(1);
      expect(Math.abs(now[k].y - before[k].y), k).toBeLessThanOrEqual(1);
      expect(Math.abs(now[k].width - before[k].width), k).toBeLessThanOrEqual(1);
      expect(Math.abs(now[k].height - before[k].height), k).toBeLessThanOrEqual(1);
    }
  };

  // Play, then open the Mixer: the same engine plays on; lanes and headers appear below.
  await page.getByTestId("rehearse-play").click();
  await expect.poll(async () => (await engine(page))?.status, { timeout: 30_000 }).toBe("playing");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByTestId("track-strip")).toHaveCount(1);
  await expect(timeline).toHaveAttribute("data-lanes", "1");
  await expect(timeline).toHaveAttribute("data-overview-height", "80");
  expect((await engine(page))?.status).toBe("playing");
  await same();

  // Close it again: still playing, still in place.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(panel.getByTestId("track-strip")).toHaveCount(0);
  expect((await engine(page))?.status).toBe("playing");
  await same();
  await page.getByTestId("rehearse-play").click();
  await expect.poll(async () => (await engine(page))?.status).toBe("stopped");
  await noHorizontalOverflow(page);

  // The vertical zoom sets the overview's height and keeps it when the Mixer opens.
  await panel.getByTestId("lanes-taller").click();
  await expect(timeline).toHaveAttribute("data-overview-height", "100");
  await toggle.click();
  await expect(timeline).toHaveAttribute("data-overview-height", "100");

  // Reload: the open Mixer is remembered on this device.
  await page.reload();
  await expect(panel.getByTestId("track-strip")).toHaveCount(1, { timeout: 30_000 });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await page.reload();
  await expect(panel.getByTestId("rehearse-play")).toBeEnabled({ timeout: 30_000 });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(timeline).toHaveAttribute("data-lanes", "0");
});

test("lane labels: only lanes with items, in a narrow column with the Mixer closed", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(540_000);
  await loginAsNewUser(page, request, testInfo, "member");
  await songWithTrack(page, testInfo);
  const panel = page.getByTestId("rehearse-panel");
  const labels = panel.getByTestId("lane-labels");
  const detail = panel.getByTestId("timeline-detail");
  const overview = panel.getByTestId("timeline-overview");

  // No sections, markers or comments: no top lanes and no label column; full-width timeline.
  await expect(labels).toHaveCount(0);
  expect(Math.abs((await box(detail)).width - (await box(overview)).width)).toBeLessThanOrEqual(1);

  // The first marker makes its lane (and the column) appear; there is still no Sections lane.
  await page.getByTestId("add-marker").click();
  await expect(panel.getByTestId("marker-item")).toHaveCount(1);
  await expect(labels.getByTestId("lane-label-markers")).toHaveText("Markers");
  await expect(labels.getByTestId("lane-label-sections")).toHaveCount(0);
  await expect(labels.getByTestId("lane-label-comments")).toHaveCount(0);

  // The first comment adds the Comments lane.
  await page.getByTestId("comment-at-playhead").click();
  const comments = page.getByTestId("comments-panel");
  await comments.getByTestId("comment-input").fill("Lane label check");
  await comments.getByTestId("comment-input-submit").click();
  await expect(comments.getByTestId("comment-item")).toHaveCount(1);
  await page.keyboard.press("Escape");
  const close = page.getByTestId("comments-close");
  if (await close.isVisible()) await close.click({ timeout: 5_000 }).catch(() => undefined);
  await expect(close).toBeHidden();
  await expect(labels.getByTestId("lane-label-comments")).toHaveText("Comments");
  await expect(labels.getByTestId("lane-label-sections")).toHaveCount(0);
  // The column is narrow: the detail view starts right of it, the overview keeps the full width.
  const col = await box(labels);
  expect(col.width).toBeLessThanOrEqual(isMobile(testInfo) ? 72 : 88);
  expect((await box(detail)).x).toBeGreaterThanOrEqual(col.x + col.width - 1);
  expect((await box(overview)).x).toBeLessThanOrEqual(col.x + 1);
  await noHorizontalOverflow(page);

  // Mixer open: the labels move to the track-header column; the narrow column goes.
  await page.getByTestId("mixer-toggle").click();
  const headers = panel.getByTestId("track-headers");
  await expect(headers.getByTestId("lane-label-markers")).toBeVisible();
  await expect(headers.getByTestId("lane-label-comments")).toBeVisible();
  await expect(labels).toHaveCount(0);
  await page.getByTestId("mixer-toggle").click();
  await expect(labels).toBeVisible();

  // 360 px wide: the labels still fit without a horizontal scroll.
  await page.setViewportSize({ width: 360, height: 740 });
  await expect(labels.getByTestId("lane-label-comments")).toBeVisible();
  await noHorizontalOverflow(page);
});

test("Mixer on phones: track lanes with narrow headers; the transport stays sticky on top", async ({
  page,
  request,
}, testInfo) => {
  test.skip(!isMobile(testInfo), "phone layout");
  test.setTimeout(540_000);
  await loginAsNewUser(page, request, testInfo, "member");
  await songWithTrack(page, testInfo);
  const toggle = page.getByTestId("mixer-toggle");

  // Off → on: a header per track beside its lane, M/S at full touch size.
  await toggle.click();
  const strip = page.getByTestId("track-strip");
  await expect(strip).toHaveCount(1, { timeout: 30_000 });
  const mute = strip.getByTestId("track-mute");
  await expect(mute).toBeVisible();
  expect((await mute.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  // The name opens the track's settings with the fader.
  await strip.getByTestId("track-settings").click(TAP_NAME);
  await expect(page.getByTestId("track-settings-panel").getByTestId("track-fader")).toBeVisible();
  await page.keyboard.press("Escape");

  // Scrolled down within the Player, the transport sticks under the app header.
  const header = await box(page.getByTestId("app-header"));
  const headerBottom = Math.round(header.y + header.height);
  const top = (await box(page.getByTestId("rehearse-transport"))).y;
  await page.evaluate(
    (by) => {
      window.scrollBy(0, by);
    },
    top - headerBottom + 120,
  );
  await expect
    .poll(async () => Math.round((await box(page.getByTestId("rehearse-transport"))).y))
    .toBe(headerBottom);
  await expect(page.getByTestId("rehearse-play")).toBeInViewport();

  // On → off: the same button closes the Mixer again.
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("track-strip")).toHaveCount(0);
  await noHorizontalOverflow(page);
});

test("a long song title wraps by words next to the header buttons (portrait and landscape)", async ({
  page,
  request,
}, testInfo) => {
  await loginAsNewUser(page, request, testInfo, "member");
  await newProject(page, testInfo);
  const title = "The Doors - LA Woman";
  await newSong(page, title);
  const heading = page.getByTestId("song-title");
  await expect(heading).toHaveText(title);
  await expect(page.getByTestId("mixer-toggle")).toBeVisible();

  for (const size of [
    { width: 360, height: 740 },
    { width: 740, height: 360 },
    { width: 852, height: 393 },
  ]) {
    await page.setViewportSize(size);
    await noHorizontalOverflow(page);
    // Every word stays whole: the title is at least as wide as its longest word and takes at
    // most two lines (it broke into one character per line before).
    const lines = await heading.evaluate((el) => {
      const lh = parseFloat(getComputedStyle(el).lineHeight);
      return Math.round(el.getBoundingClientRect().height / lh);
    });
    expect(lines, `${String(size.width)}×${String(size.height)}`).toBeLessThanOrEqual(2);
    const word = await heading.evaluate((el) => {
      const range = document.createRange();
      const text = el.firstChild;
      if (!text) return 0;
      const at = el.textContent.indexOf("Woman");
      range.setStart(text, at);
      range.setEnd(text, at + "Woman".length);
      return range.getClientRects().length;
    });
    expect(word).toBe(1);
    // The header buttons stay within the screen (they wrap below the title when needed).
    const buttons = await box(page.getByTestId("mixer-toggle"));
    expect(buttons.x + buttons.width).toBeLessThanOrEqual(size.width);
  }
});

test("track rows keep the track name readable at 360 px", async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
  await loginAsNewUser(page, request, testInfo, "member");
  await newProject(page, testInfo);
  await newSong(page, "Narrow rows");
  await page.getByTestId("track-dropzone").locator('input[type="file"]').setInputFiles(TONE_FILE());
  const row = page.getByTestId("track-row").first();
  await expect(row.getByTestId("version-button")).toBeVisible({ timeout: 60_000 });
  await page.setViewportSize({ width: 360, height: 740 });
  const name = row.getByTestId("track-name");
  await expect(name).toHaveText("tone_48000_s16_stereo");
  // It was cut to one letter ("t…") next to the version badge and the actions; now it shows
  // several characters (about 9 with desktop Chrome's scrollbar, more on phones).
  expect((await box(name)).width).toBeGreaterThanOrEqual(60);
  // "New version" is an icon on phones; the actions keep 44 px touch targets.
  for (const id of ["upload-version", "track-actions"]) {
    const b = await box(row.getByTestId(id));
    expect(Math.min(b.width, b.height), id).toBeGreaterThanOrEqual(44);
  }
  const rowBox = await box(row);
  const actions = await box(row.getByTestId("track-actions"));
  expect(actions.x + actions.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 0.5);
  await noHorizontalOverflow(page);
});

interface ClickDebug {
  clickSettings: { enabled: boolean; solo: boolean; gainDb: number };
  hasTempo: boolean;
}

const clickState = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as { __bandroomRehearse?: { state: () => ClickDebug } }
      ).__bandroomRehearse?.state() ?? null,
  );

test("Mixer: the click is a lane with its own header (M, S, volume), saved like a track", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(600_000);
  const phone = isMobile(testInfo);
  await loginAsNewUser(page, request, testInfo, "member");
  await songWithTrack(page, testInfo);
  const songId = /songs\/([^/?#]+)/.exec(page.url())?.[1] ?? "";
  const timeline = page.getByTestId("timeline");
  const headers = page.getByTestId("track-headers");

  // Without a tempo map there is no click lane.
  await page.getByTestId("mixer-toggle").click();
  await expect(timeline).toHaveAttribute("data-lanes", "1", { timeout: 30_000 });
  await expect(page.getByTestId("click-strip")).toHaveCount(0);

  const put = await page.request.put(`api/v1/songs/${songId}/tempo`, {
    headers: { "X-Requested-With": "bandroom" },
    data: {
      map: { segments: [{ startBeat: 0, bpm: 120, meter: { num: 4, den: 4 } }] },
      bar1OffsetSec: 0,
    },
  });
  expect(put.status()).toBe(200);
  await page.reload();
  const strip = headers.getByTestId("click-strip");
  await expect(strip).toBeVisible({ timeout: 30_000 });
  await expect(timeline).toHaveAttribute("data-lanes", "2");
  if (phone) await noHorizontalOverflow(page);

  // M is the click switched off (it starts off), the same state as the transport's Click.
  const mute = strip.getByTestId("click-mute");
  const solo = strip.getByTestId("click-solo");
  for (const b of [mute, solo]) {
    const r = await box(b);
    expect(r.width).toBeGreaterThanOrEqual(44);
    expect(r.height).toBeGreaterThanOrEqual(44);
  }
  await expect(mute).toHaveAttribute("aria-pressed", "true");
  await mute.click();
  await expect(mute).toHaveAttribute("aria-pressed", "false");
  if (!phone)
    await expect(page.getByTestId("click-toggle")).toHaveAttribute("aria-pressed", "true");
  await solo.click();
  await expect(solo).toHaveAttribute("aria-pressed", "true");

  // The volume: inline on wide headers, in the bottom sheet on phones.
  if (phone) {
    await strip.getByTestId("click-strip-settings").click(TAP_NAME);
    await expect(page.getByTestId("click-settings")).toBeVisible();
  }
  const volume = page.getByRole("slider", { name: "Click volume" }).first();
  await volume.focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  if (phone) await page.keyboard.press("Escape");
  await expect
    .poll(async () => (await clickState(page))?.clickSettings)
    .toMatchObject({ enabled: true, solo: true, gainDb: -8 });

  // Saved with the personal mix: after a reload the header shows the same state.
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`api/v1/songs/${songId}/mixer`, {
          headers: { "X-Requested-With": "bandroom" },
        });
        const body = (await res.json()) as {
          state: { click?: { enabled?: boolean; solo?: boolean; gainDb?: number } } | null;
        };
        return body.state?.click;
      },
      { timeout: 15_000 },
    )
    .toMatchObject({ enabled: true, solo: true, gainDb: -8 });
  await page.reload();
  await expect(strip).toBeVisible({ timeout: 30_000 });
  await expect(mute).toHaveAttribute("aria-pressed", "false");
  await expect(solo).toHaveAttribute("aria-pressed", "true");
  expect((await clickState(page))?.clickSettings.gainDb).toBe(-8);

  // With the Mixer closed the click lane goes with the track lanes.
  await page.getByTestId("mixer-toggle").click();
  await expect(timeline).toHaveAttribute("data-lanes", "0");
  await expect(page.getByTestId("click-strip")).toHaveCount(0);
});
