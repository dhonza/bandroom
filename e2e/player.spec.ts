import { expect, test, type Page, type TestInfo } from "@playwright/test";
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

/** The mix player's position readout ("0:02.345"), in seconds. */
async function mixClock(page: Page): Promise<number> {
  const text = (await page.getByTestId("listen-position").textContent()) ?? "0:00.000";
  const [m, s] = text.split(":").map(Number);
  return (m ?? 0) * 60 + (s ?? 0);
}

/** A song with one processed track (10 s tone) whose mix is ready; the player shows the mix. */
async function songWithMix(page: Page, testInfo: TestInfo): Promise<void> {
  await page.goto("library");
  await page.getByTestId("new-project").click();
  await page.getByLabel("Name").fill(`Player ${uniqueUsername(testInfo)}`);
  await page.getByTestId("create-project-submit").click();
  await page.getByTestId("project-settings-tab").waitFor();
  await page.getByTestId("new-song").click();
  await page.getByLabel("Title", { exact: true }).fill("Hand-off");
  await page.getByTestId("create-song-submit").click();
  await page.getByTestId("song-row").filter({ hasText: "Hand-off" }).getByRole("link").click();
  // Uploaded on the open page: the player stays on the mix while it is prepared.
  await page.getByTestId("track-dropzone").locator('input[type="file"]').setInputFiles(TONE_FILE());
  // One worker processes every test's uploads on this server; the automatic mix queues behind
  // them (plus its 60 s debounce), so under full-suite load this can take minutes.
  await expect(page.getByTestId("listen-panel").getByTestId("listen-play")).toBeEnabled({
    timeout: 420_000,
  });
  await expect(page.getByTestId("mixer-toggle")).toHaveAttribute("aria-pressed", "false");
}

test("Mixer toggle hands playback over at the same position and is remembered", async ({
  page,
  request,
}, testInfo) => {
  // The mix player (<audio>, Opus) is covered in Chromium like listen.spec; Safari is a device
  // test (DEVICE-TESTS M5.11).
  test.skip(testInfo.project.name.includes("webkit") || testInfo.project.name.includes("iphone"));
  test.setTimeout(540_000);
  await loginAsNewUser(page, request, testInfo, "member");
  await songWithMix(page, testInfo);
  const toggle = page.getByTestId("mixer-toggle");
  const mixOff = async () => {
    await toggle.click();
    await expect(page.getByTestId("listen-panel")).toBeVisible();
  };
  const mixerOn = async () => {
    await toggle.click();
    await expect(page.getByTestId("rehearse-panel")).toBeVisible();
    await expect(page.getByTestId("track-strip")).toHaveCount(1);
  };

  // The mix plays from 2 s (a tap on the timeline cues it there).
  const detail = page.getByTestId("timeline-detail");
  const box = await detail.boundingBox();
  if (!box) throw new Error("no timeline");
  await detail.click({ position: { x: box.width * 0.2, y: box.height / 2 } });
  await expect.poll(() => mixClock(page)).toBeGreaterThanOrEqual(1);
  await page.getByTestId("listen-play").click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect.poll(() => mixClock(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);

  // Mixer on while playing: the engine continues from there, playing.
  let before = await mixClock(page);
  let t0 = Date.now();
  await mixerOn();
  await expect.poll(async () => (await engine(page))?.status, { timeout: 30_000 }).toBe("playing");
  let at = ((await engine(page))?.position ?? 0) / 48_000;
  expect(at).toBeGreaterThanOrEqual(before - 1);
  expect(at).toBeLessThanOrEqual(before + 1 + (Date.now() - t0) / 1000);

  // Mixer off while playing: the mix continues from the engine's position.
  at = ((await engine(page))?.position ?? 0) / 48_000;
  t0 = Date.now();
  await mixOff();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible({
    timeout: 15_000,
  });
  const after = await mixClock(page);
  expect(after).toBeGreaterThanOrEqual(at - 1);
  expect(after).toBeLessThanOrEqual(at + 1 + (Date.now() - t0) / 1000);
  // The engine's pause is reported back from the worklet asynchronously; a short poll still
  // catches an engine that keeps playing next to the mix.
  await expect
    .poll(async () => (await engine(page))?.status, { timeout: 2_000 })
    .not.toBe("playing");

  // Paused hand-off stays paused at the same position, both ways.
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByTestId("listen-play")).toHaveAccessibleName("Play");
  before = await mixClock(page);
  await mixerOn();
  await expect.poll(async () => (await engine(page))?.status, { timeout: 30_000 }).toBe("stopped");
  at = ((await engine(page))?.position ?? 0) / 48_000;
  expect(Math.abs(at - before)).toBeLessThan(0.3);
  await expect(page.getByTestId("rehearse-play")).toHaveAccessibleName("Play");
  // Negative check: nothing starts playback late. A fixed observation window is inherent here.
  await page.waitForTimeout(1000);
  expect((await engine(page))?.status).toBe("stopped");

  // Reload: the open Mixer is remembered on this device.
  await page.reload();
  await expect(page.getByTestId("rehearse-panel")).toBeVisible({ timeout: 30_000 });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await engine(page))?.status, { timeout: 30_000 }).toBe("stopped");
  // Seek the engine to ~50 % (paused), then close the Mixer: the mix is cued there, paused.
  const lanes = page.getByTestId("timeline-detail");
  const lb = await lanes.boundingBox();
  if (!lb) throw new Error("no timeline");
  await lanes.click({ position: { x: lb.width * 0.5, y: 10 } });
  await expect.poll(async () => ((await engine(page))?.position ?? 0) / 48_000).toBeGreaterThan(3);
  at = ((await engine(page))?.position ?? 0) / 48_000;
  await mixOff();
  await expect(page.getByTestId("listen-play")).toHaveAccessibleName("Play");
  expect(Math.abs((await mixClock(page)) - at)).toBeLessThan(0.1);

  await page.reload();
  await expect(page.getByTestId("listen-panel")).toBeVisible({ timeout: 30_000 });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
});

test("Mixer on phones: track lanes with narrow headers; the toggle returns to the mix", async ({
  page,
  request,
}, testInfo) => {
  test.skip(!isMobile(testInfo), "phone layout");
  test.setTimeout(540_000);
  await loginAsNewUser(page, request, testInfo, "member");
  await songWithMix(page, testInfo);
  const toggle = page.getByTestId("mixer-toggle");
  // The mix player shows one waveform: what plays (DECISIONS 2026-10-07).
  await expect(page.getByTestId("listen-panel").getByTestId("timeline")).toHaveAttribute(
    "data-lanes",
    "1",
  );

  // Off → on: a header per track beside its lane, M/S at full touch size.
  await toggle.click();
  await expect(page.getByTestId("rehearse-panel")).toBeVisible({ timeout: 30_000 });
  const strip = page.getByTestId("track-strip");
  await expect(strip).toHaveCount(1, { timeout: 30_000 });
  const mute = strip.getByTestId("track-mute");
  await expect(mute).toBeVisible();
  expect((await mute.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByTestId("rehearse-transport")).toBeVisible();
  // The name opens the track's settings with the fader.
  await strip.getByTestId("track-settings").click(TAP_NAME);
  await expect(page.getByTestId("track-settings-panel").getByTestId("track-fader")).toBeVisible();
  await page.keyboard.press("Escape");

  // On → off: the same button plays the mix again.
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect(page.getByTestId("listen-panel")).toBeVisible();
  await expect(page.getByTestId("rehearse-panel")).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(0);
});
