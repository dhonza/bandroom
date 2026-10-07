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
