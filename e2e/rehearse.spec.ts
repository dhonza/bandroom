import { expect, test, type Page } from "@playwright/test";
import { AIFF_FILE, generateFixtures, TONE_FILE } from "@bandroom/fixtures";
import { isMobile, loginAsNewUser, openMixer, uniqueUsername } from "./helpers";

test.beforeAll(async () => {
  await generateFixtures();
});

interface DebugState {
  status: string;
  position: number;
  length: number;
  tracks: { id: string; version: string; kind: string }[];
  mix: { tracks: Record<string, { mute: boolean; solo: boolean }> };
  errors: Record<string, string>;
  /** Songs loaded into the engine so far. */
  loads?: number;
}

/** Engine state exposed by the Rehearse controller (SPEC §20: debug state for e2e). */
const debug = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as { __bandroomRehearse?: { state: () => DebugState } }
      ).__bandroomRehearse?.state() ?? null,
  );

test("Rehearse: multitrack play, mute/solo, seek, personal mix persists", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  const phone = isMobile(testInfo);
  await loginAsNewUser(page, request, testInfo, "member");

  await page.goto("library");
  await page.getByTestId("new-project").click();
  await page.getByLabel("Name").fill(`Rehearse ${uniqueUsername(testInfo)}`);
  await page.getByTestId("create-project-submit").click();
  await page.getByTestId("project-settings-tab").waitFor();
  await page.getByTestId("new-song").click();
  await page.getByLabel("Title", { exact: true }).fill("Two tracks");
  await page.getByTestId("create-song-submit").click();
  await page.getByTestId("song-row").filter({ hasText: "Two tracks" }).getByRole("link").click();

  // Two tracks at different sample rates (48 kHz WAV, 44.1 kHz AIFF).
  await page
    .getByTestId("track-dropzone")
    .locator('input[type="file"]')
    .setInputFiles([TONE_FILE(), AIFF_FILE()]);
  const rows = page.getByTestId("track-row");
  await expect(rows).toHaveCount(2, { timeout: 20_000 });
  // One worker serves all parallel tests on this server.
  await expect(rows.filter({ hasText: "kHz" })).toHaveCount(2, { timeout: 180_000 });

  await openMixer(page);
  const panel = page.getByTestId("rehearse-panel");
  await expect(panel).toBeVisible();
  await expect.poll(async () => (await debug(page))?.status, { timeout: 30_000 }).toBe("stopped");
  expect((await debug(page))?.tracks).toHaveLength(2);

  await page.getByTestId("rehearse-play").click();
  await expect.poll(async () => (await debug(page))?.status, { timeout: 30_000 }).toBe("playing");
  const p1 = (await debug(page))?.position ?? 0;
  await expect.poll(async () => (await debug(page))?.position ?? 0).toBeGreaterThan(p1 + 12_000);

  // Mute the first track, solo the second from the track headers (every screen).
  const strips = panel.getByTestId("track-headers").getByTestId("track-strip");
  await expect(strips).toHaveCount(2);
  // The personal mix is saved (debounced): wait for the save that carries both changes.
  const mixSaved = page.waitForResponse(
    (res) => {
      const req = res.request();
      if (req.method() !== "PUT" || !/\/songs\/[^/]+\/mixer$/.test(new URL(res.url()).pathname))
        return false;
      const body = req.postDataJSON() as {
        state: { tracks: Record<string, { mute?: boolean; solo?: boolean }> };
      };
      const tracks = Object.values(body.state.tracks);
      return res.ok() && tracks.some((t) => t.mute) && tracks.some((t) => t.solo);
    },
    { timeout: 30_000 },
  );
  await strips.nth(0).getByTestId("track-mute").click();
  await strips.nth(1).getByTestId("track-solo").click();
  const state = await debug(page);
  const [a, b] = state?.tracks.map((t) => t.id) ?? [];
  expect(state?.mix.tracks[a ?? ""]?.mute).toBe(true);
  expect(state?.mix.tracks[b ?? ""]?.solo).toBe(true);

  // Seek by tapping the detail timeline near the middle.
  const detail = page.getByTestId("timeline-detail");
  const box = await detail.boundingBox();
  if (!box) throw new Error("no timeline");
  await detail.click({ position: { x: box.width * 0.5, y: 10 } });
  await expect
    .poll(async () => {
      const s = await debug(page);
      return s ? s.position / s.length : 0;
    })
    .toBeGreaterThan(0.4);
  expect((await debug(page))?.errors).toEqual({});

  // The personal mix was saved and the open Mixer is remembered on this device.
  await mixSaved;
  await page.reload();
  await expect(page.getByTestId("rehearse-panel")).toBeVisible();
  await expect
    .poll(async () => (await debug(page))?.mix.tracks[a ?? ""]?.mute, { timeout: 30_000 })
    .toBe(true);

  // Version switch for me (desktop): a second upload of the tone becomes v2 (current); listening
  // to v1 again from the header's version stack is personal and marks the track "not current".
  if (phone) return;
  // The project creator (manager) can make this mix everyone's default.
  await page.getByTestId("mixer-save-defaults").click();
  await expect(page.getByText("Default mix saved.")).toBeVisible();

  await page.getByTestId("track-dropzone").locator('input[type="file"]').setInputFiles(TONE_FILE());
  await page.getByTestId("match-confirm").click();
  const tone = page
    .getByTestId("track-headers")
    .getByTestId("track-strip")
    .filter({ hasText: "tone" });
  await expect(tone.getByTestId("track-version")).toContainText("v2", { timeout: 180_000 });
  const before = (await debug(page))?.tracks.find((t) => t.id === a)?.version;
  await tone.getByTestId("track-version").click();
  await page
    .getByTestId("version-item")
    .filter({ hasText: "v1" })
    .getByTestId("version-listen")
    .click();
  await expect(tone.getByTestId("track-version")).toContainText("v1");
  await expect(tone.getByText("not current")).toBeVisible();
  expect((await debug(page))?.tracks.find((t) => t.id === a)?.version).not.toBe(before);
});

test("Rehearse: recovers when the browser does not resume the audio context", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  // Safari can leave the context interrupted after another player took the audio: resume() then
  // never settles. Contexts marked `__stuck` behave like that.
  await page.addInitScript(() => {
    const w = window as unknown as { __ctxs: AudioContext[]; AudioContext: typeof AudioContext };
    const Orig = w.AudioContext;
    w.__ctxs = [];
    w.AudioContext = class extends Orig {
      constructor(opts?: AudioContextOptions) {
        super(opts);
        w.__ctxs.push(this);
      }
      override resume(): Promise<void> {
        return (this as { __stuck?: boolean }).__stuck
          ? new Promise(() => undefined)
          : super.resume();
      }
    };
  });
  await loginAsNewUser(page, request, testInfo, "member");
  await page.goto("library");
  await page.getByTestId("new-project").click();
  await page.getByLabel("Name").fill(`Stuck ${uniqueUsername(testInfo)}`);
  await page.getByTestId("create-project-submit").click();
  await page.getByTestId("new-song").click();
  await page.getByLabel("Title", { exact: true }).fill("Stuck context");
  await page.getByTestId("create-song-submit").click();
  await page.getByTestId("song-row").filter({ hasText: "Stuck context" }).getByRole("link").click();
  await page.getByTestId("track-dropzone").locator('input[type="file"]').setInputFiles(TONE_FILE());
  await expect(page.getByTestId("track-row").filter({ hasText: "kHz" })).toHaveCount(1, {
    timeout: 180_000,
  });

  await openMixer(page);
  await expect.poll(async () => (await debug(page))?.status, { timeout: 30_000 }).toBe("stopped");
  const play = page.getByTestId("rehearse-play");
  await play.click();
  await expect.poll(async () => (await debug(page))?.status, { timeout: 30_000 }).toBe("playing");
  await expect.poll(async () => (await debug(page))?.position ?? 0).toBeGreaterThan(48_000);
  await play.click();
  await expect.poll(async () => (await debug(page))?.status).toBe("stopped");
  const at = (await debug(page))?.position ?? 0;

  // The context gets suspended and no longer resumes: play reports an interruption, no spinner.
  await page.evaluate(async () => {
    const ctx = (window as unknown as { __ctxs: AudioContext[] }).__ctxs.at(-1);
    if (!ctx) throw new Error("no AudioContext");
    (ctx as { __stuck?: boolean }).__stuck = true;
    await ctx.suspend();
  });
  await play.click();
  await expect
    .poll(async () => (await debug(page))?.status, { timeout: 10_000 })
    .toBe("interrupted");
  await expect(page.getByTestId("rehearse-interrupted")).toBeVisible();

  // The next tap replaces the context and continues from the same position.
  await play.click();
  await expect.poll(async () => (await debug(page))?.status, { timeout: 30_000 }).toBe("playing");
  expect(
    await page.evaluate(() => (window as unknown as { __ctxs: unknown[] }).__ctxs.length),
  ).toBe(2);
  await expect.poll(async () => (await debug(page))?.position ?? 0).toBeGreaterThan(at + 24_000);
  expect((await debug(page))?.errors).toEqual({});
});

test("Tracks: drag-reorder by keyboard while playing; the lanes follow without reloading", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(300_000);
  await loginAsNewUser(page, request, testInfo, "member");
  await page.goto("library");
  await page.getByTestId("new-project").click();
  await page.getByLabel("Name").fill(`Reorder ${uniqueUsername(testInfo)}`);
  await page.getByTestId("create-project-submit").click();
  await page.getByTestId("project-settings-tab").waitFor();
  await page.getByTestId("new-song").click();
  await page.getByLabel("Title", { exact: true }).fill("Order");
  await page.getByTestId("create-song-submit").click();
  await page.getByTestId("song-row").filter({ hasText: "Order" }).getByRole("link").click();
  await page
    .getByTestId("track-dropzone")
    .locator('input[type="file"]')
    .setInputFiles([TONE_FILE(), AIFF_FILE()]);
  const rows = page.getByTestId("track-row");
  await expect(rows).toHaveCount(2, { timeout: 20_000 });
  await expect(rows.filter({ hasText: "kHz" })).toHaveCount(2, { timeout: 180_000 });
  const rowIds = async () =>
    Promise.all((await rows.all()).map(async (r) => (await r.getAttribute("data-track-id")) ?? ""));
  const [first, second] = await rowIds();

  await openMixer(page);
  await expect.poll(async () => (await debug(page))?.status, { timeout: 30_000 }).toBe("stopped");
  await page.getByTestId("rehearse-play").click();
  await expect.poll(async () => (await debug(page))?.status, { timeout: 30_000 }).toBe("playing");
  const loads = async () => (await debug(page))?.loads ?? -1;
  const loadsBefore = await loads();
  expect(loadsBefore).toBeGreaterThan(0);

  // Keyboard reordering (dnd-kit): pick up the second track, move it up, drop.
  const secondName = (await rows.nth(1).getAttribute("data-track")) ?? "";
  const handle = page.getByRole("button", { name: `Reorder ${secondName}` });
  const live = page.locator('[id^="DndLiveRegion"]');
  await handle.focus();
  await page.keyboard.press("Space");
  await expect(live).toContainText(`over droppable area ${second ?? ""}.`);
  await expect(async () => {
    if ((await live.textContent())?.includes(`over droppable area ${first ?? ""}.`)) return;
    await page.keyboard.press("ArrowUp");
    await expect(live).toContainText(`over droppable area ${first ?? ""}.`, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await page.keyboard.press("Space");
  await expect(live).toContainText(/dropped/i);
  await expect.poll(rowIds).toEqual([second, first]);

  // The Mixer lanes follow the new order; the audio keeps playing without a reload.
  await expect
    .poll(async () => (await debug(page))?.tracks.map((tr) => tr.id))
    .toEqual([second, first]);
  expect(await loads()).toBe(loadsBefore);
  expect((await debug(page))?.status).toBe("playing");

  // Persisted.
  await page.reload();
  await expect.poll(rowIds, { timeout: 30_000 }).toEqual([second, first]);
  if (isMobile(testInfo)) {
    await page.setViewportSize({ width: 360, height: 740 });
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      )
      .toBeLessThanOrEqual(0);
  }
});

test("Mixer: open or closed is remembered per song on this device", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  await loginAsNewUser(page, request, testInfo, "member");
  await page.goto("library");
  await page.getByTestId("new-project").click();
  await page.getByLabel("Name").fill(`Mixer memory ${uniqueUsername(testInfo)}`);
  await page.getByTestId("create-project-submit").click();
  await page.getByTestId("project-settings-tab").waitFor();
  for (const title of ["Song A", "Song B"]) {
    await page.getByTestId("new-song").click();
    await page.getByLabel("Title", { exact: true }).fill(title);
    await page.getByTestId("create-song-submit").click();
    await expect(page.getByTestId("song-row").filter({ hasText: title })).toBeVisible({
      timeout: 30_000,
    });
  }
  const toggle = page.getByTestId("mixer-toggle");
  const openSong = async (title: string) => {
    await page.getByTestId("song-row").filter({ hasText: title }).getByRole("link").click();
    await expect(page.getByTestId("song-title")).toContainText(title, { timeout: 30_000 });
  };
  // The Mixer button needs a track; each song gets one.
  for (const title of ["Song A", "Song B"]) {
    await openSong(title);
    await page
      .getByTestId("track-dropzone")
      .locator('input[type="file"]')
      .setInputFiles(TONE_FILE());
    await expect(page.getByTestId("track-row")).toHaveCount(1, { timeout: 60_000 });
    await expect(toggle).toBeEnabled({ timeout: 30_000 });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await page.goBack();
  }

  await openSong("Song A");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await page.goBack();
  await openSong("Song B");
  await expect(toggle).toBeEnabled({ timeout: 30_000 });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await page.goBack();
  await openSong("Song A");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
});
