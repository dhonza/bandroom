import { expect, test, type Locator, type Page } from "@playwright/test";
import { generateFixtures, REAPER_MIDI_FILE, SMPTE_MIDI_FILE, TONE_FILE } from "@bandroom/fixtures";
import { isMobile, loginAsNewUser, openMixer, uniqueUsername } from "./helpers";

test.beforeAll(async () => {
  await generateFixtures();
});

interface CountIn {
  clicks: number;
  perBar: number;
  intervalFrames: number;
}

interface DebugState {
  status: string;
  position: number;
  length: number;
  loop: { start: number; end: number } | null;
  lap: number;
  hasTempo: boolean;
  clickSettings: { enabled: boolean; countIn: boolean; countInEveryRepeat: boolean };
  click: { enabled: boolean } | null;
  clicks: number;
  countIn: { beat: number; clicks: number } | null;
  lastCountIn: CountIn | null;
  repeatCountIn: CountIn | null;
}

/** Engine state exposed by the Rehearse controller (SPEC §20: debug state for e2e). */
const debug = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as { __bandroomRehearse?: { state: () => DebugState } }
      ).__bandroomRehearse?.state() ?? null,
  );

async function dragRuler(page: Page, a: number, b: number) {
  const detail = page.getByTestId("timeline-detail");
  // Center it: "if needed" leaves the ruler under the fixed header when the timeline is tall.
  await detail.evaluate((el) => {
    el.scrollIntoView({ block: "center", behavior: "instant" });
  });
  const box = await detail.boundingBox();
  if (!box) throw new Error("no timeline");
  const y = box.y + 10;
  await page.mouse.move(box.x + box.width * a, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * ((a + b) / 2), y, { steps: 4 });
  await page.mouse.move(box.x + box.width * b, y, { steps: 4 });
  await page.mouse.up();
}

interface ApiMarker {
  name: string;
  type: string;
  anchor: string;
  startSec: number;
  endSec: number | null;
  startBeat: number | null;
}

async function songMarkers(page: Page, songId: string): Promise<ApiMarker[]> {
  const res = await page.request.get(`api/v1/songs/${songId}/markers`, {
    headers: { "X-Requested-With": "bandroom" },
  });
  return ((await res.json()) as { markers: ApiMarker[] }).markers;
}

/** The saved tempo map as [bar, startBeat, bpm, "num/den"] rows. */
async function tempoRows(page: Page, songId: string): Promise<[number, number, number, string][]> {
  const res = await page.request.get(`api/v1/songs/${songId}/tempo`, {
    headers: { "X-Requested-With": "bandroom" },
  });
  const body = (await res.json()) as {
    tempo: {
      map: {
        segments: {
          startBeat: number;
          bpm: number;
          barIndex: number;
          meter: { num: number; den: number };
        }[];
      };
    } | null;
  };
  return (body.tempo?.map.segments ?? []).map((s) => [
    s.barIndex + 1,
    s.startBeat,
    s.bpm,
    `${s.meter.num}/${s.meter.den}`,
  ]);
}

/** Types a time signature and leaves the field (its suggestions would cover other inputs). */
async function fillMeter(input: Locator, value: string) {
  await input.fill(value);
  await input.blur();
}

/** Opens the transport's ⋯ menu (phones) and clicks an item. */
async function phoneMenu(page: Page, testId: string) {
  await page.getByRole("button", { name: "Playback options" }).last().click();
  await page.getByTestId(testId).click();
  await closeMenu(page);
}

/** Closes an open menu and waits until its dropdown is gone (it may cover the timeline). */
async function closeMenu(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
}

test("Tempo: MIDI import with markers, manual tempo, grid snapping, click and count-in", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(300_000);
  const phone = isMobile(testInfo);
  await loginAsNewUser(page, request, testInfo, "member");

  await page.goto("library");
  await page.getByTestId("new-project").click();
  await page.getByLabel("Name").fill(`Tempo ${uniqueUsername(testInfo)}`);
  await page.getByTestId("create-project-submit").click();
  await page.getByTestId("project-settings-tab").waitFor();
  await page.getByTestId("new-song").click();
  await page.getByLabel("Title", { exact: true }).fill("Count me in");
  await page.getByTestId("create-song-submit").click();
  await page.getByTestId("song-row").filter({ hasText: "Count me in" }).getByRole("link").click();
  const songId = /songs\/([^/?#]+)/.exec(page.url())?.[1] ?? "";
  expect(songId).not.toBe("");

  await page.getByTestId("track-dropzone").locator('input[type="file"]').setInputFiles(TONE_FILE());
  const rows = page.getByTestId("track-row");
  await expect(rows).toHaveCount(1, { timeout: 20_000 });
  await expect(rows.filter({ hasText: "kHz" })).toHaveCount(1, { timeout: 180_000 });

  await openMixer(page);
  await expect.poll(async () => (await debug(page))?.status, { timeout: 30_000 }).toBe("stopped");
  // No tempo map yet: click and count-in are greyed out, no bar.beat readout.
  expect((await debug(page))?.hasTempo).toBe(false);
  if (!phone) await expect(page.getByTestId("click-toggle")).toBeDisabled();
  await expect(page.getByTestId("bar-beat")).toHaveCount(0);

  // --- MIDI import (SPEC §7.2): an SMPTE file is rejected, the Reaper export imports. ---
  await page.getByTestId("tempo-button").click();
  const dialog = page.getByTestId("tempo-dialog");
  await dialog.getByTestId("tempo-tab-midi").click();
  const fileInput = dialog.locator('input[type="file"]');
  await fileInput.setInputFiles(SMPTE_MIDI_FILE());
  await expect(dialog.getByTestId("tempo-midi-error")).toContainText("SMPTE");
  await fileInput.setInputFiles(REAPER_MIDI_FILE());
  const preview = dialog.getByTestId("tempo-midi-preview");
  await expect(preview).toContainText("90–140 BPM");
  await expect(preview.getByRole("checkbox")).toHaveCount(6); // "all" + 5 markers
  await preview.getByText(/^Chorus/).click(); // leave the Chorus marker out
  await dialog.getByTestId("tempo-midi-import").click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await debug(page))?.hasTempo, { timeout: 15_000 }).toBe(true);
  await expect(page.getByTestId("song-tempo")).toContainText("90–140 BPM");
  const imported = await songMarkers(page, songId);
  expect(imported.map((m) => m.name)).toEqual(["Intro", "Verse 1", "Bridge", "Outro"]);
  expect(imported.every((m) => m.anchor === "musical")).toBe(true);
  expect(imported[1]?.startSec).toBeCloseTo(8, 3); // bar 5 at 120 BPM
  await expect(page.getByTestId("bar-beat").first()).toHaveText("1.1");

  // --- Manual tempo (SPEC §7.3): bar-based tempo and time signature changes. ---
  await page.getByTestId("tempo-button").click();
  await dialog.getByTestId("tempo-tab-manual").click();
  // The imported map arrives as rows; keep the first tempo, drop the other changes.
  const removeButtons = dialog.getByRole("button", { name: "Remove this change" });
  while ((await removeButtons.count()) > 0) await removeButtons.first().click();
  const changes = dialog.getByTestId("tempo-change");
  await expect(changes).toHaveCount(0);
  await dialog.getByTestId("tempo-bpm").fill("120");
  await fillMeter(dialog.getByTestId("tempo-meter"), "4/4");
  // 140 BPM from bar 5, then a 3/4 time signature change at bar 3 (sorted before it).
  await dialog.getByTestId("tempo-add-bar").fill("5");
  await dialog.getByTestId("tempo-add-change").click();
  await expect(changes).toHaveCount(1);
  await changes.nth(0).getByTestId("tempo-change-bpm").fill("140");
  await dialog.getByTestId("tempo-add-bar").fill("3");
  await dialog.getByTestId("tempo-add-meter").click();
  await expect(changes).toHaveCount(2);
  const meterRow = changes.nth(0);
  await expect(meterRow.getByTestId("tempo-change-meter")).toHaveValue("4/4"); // in effect there
  await fillMeter(meterRow.getByTestId("tempo-change-meter"), "3/4");
  // Move it to bar 4, then change bar 1 to 6/8: both changes stay on their bars.
  await meterRow.getByTestId("tempo-change-bar").fill("4");
  await fillMeter(dialog.getByTestId("tempo-meter"), "6/8");
  await expect(dialog.getByTestId("tempo-error")).toHaveCount(0);
  if (phone) {
    // No horizontal overflow in the full-screen dialog at 360 px.
    const wide = await page
      .locator(".mantine-Modal-content")
      .evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(wide).toBeLessThanOrEqual(0);
    // Each change is one compact line, even at 360 px.
    const box = await meterRow.boundingBox();
    expect(box?.height).toBeLessThan(60);
  }
  await dialog.getByTestId("tempo-save").click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("song-tempo")).toHaveText("120–140 BPM · 6/8, 3/4");
  expect(await tempoRows(page, songId)).toEqual([
    [1, 0, 120, "6/8"],
    [4, 9, 120, "3/4"],
    [5, 12, 140, "3/4"],
  ]);

  // Reopen (rows come back by bar): 4/4 again, the time signature change to bar 3, and the
  // tempo change removed → 120 BPM 4/4, 3/4 from bar 3.
  await page.getByTestId("tempo-button").click();
  await expect(changes).toHaveCount(2);
  await expect(dialog.getByTestId("tempo-changes-header")).toBeVisible();
  await expect(changes.nth(0).getByTestId("tempo-change-bar")).toHaveValue("4");
  // An empty BPM means "no tempo change here".
  await expect(changes.nth(0).getByTestId("tempo-change-bpm")).toHaveValue("");
  await expect(changes.nth(1).getByTestId("tempo-change-bpm")).toHaveValue("140");
  await changes.nth(1).getByRole("button", { name: "Remove this change" }).click();
  await fillMeter(dialog.getByTestId("tempo-meter"), "4/4");
  await changes.nth(0).getByTestId("tempo-change-bar").fill("3");
  await dialog.getByTestId("tempo-offset-1").click();
  await dialog.getByTestId("tempo-offset--1").click();
  await dialog.getByTestId("tempo-save").click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("song-tempo")).toHaveText("120 BPM · 4/4, 3/4");
  expect(await tempoRows(page, songId)).toEqual([
    [1, 0, 120, "4/4"],
    [3, 8, 120, "3/4"],
  ]);

  // --- Musical snapping (SPEC §7.5) and anchors (§7.4): beats, selection 4–8 s. ---
  if (phone) {
    await page.getByRole("button", { name: "Playback options" }).last().click();
    await page.getByRole("menuitem", { name: "Beats", exact: true }).click();
    await closeMenu(page);
  } else {
    await page.getByTestId("snap-mode").click();
    await page.getByTestId("snap-beat").click();
  }
  await dragRuler(page, 0.402, 0.798);
  await expect(page.getByTestId("selection")).toBeVisible();
  await page.getByTestId("save-as-section").click();
  const editor = page.getByTestId("marker-editor");
  await editor.getByTestId("section-presets").getByText("Chorus", { exact: true }).click();
  await expect(editor.getByTestId("marker-anchor")).toBeChecked();
  await editor.getByTestId("marker-save").click();
  await expect.poll(async () => (await songMarkers(page, songId)).length).toBe(5);
  const chorus = (await songMarkers(page, songId)).find((m) => m.name === "Chorus");
  expect(chorus).toMatchObject({ anchor: "musical", startBeat: 8 });
  expect(chorus?.startSec).toBeCloseTo(4, 3);
  expect(chorus?.endSec).toBeCloseTo(8, 3);

  // --- Count-in at the loop start uses the meter there (3/4, not 4/4), then every repeat. ---
  await page.getByTestId("selection-loop").click();
  await expect.poll(async () => (await debug(page))?.loop ?? null).not.toBeNull();
  if (phone) {
    await phoneMenu(page, "menu-count-in");
    await phoneMenu(page, "menu-click");
  } else {
    await page.getByTestId("count-in-toggle").click();
    await page.getByTestId("click-toggle").click();
  }
  await expect.poll(async () => (await debug(page))?.clickSettings.countIn).toBe(true);
  await expect.poll(async () => (await debug(page))?.click?.enabled).toBe(true);
  await page.getByTestId("rehearse-play").click();
  await expect
    .poll(async () => (await debug(page))?.lastCountIn ?? null, { timeout: 30_000 })
    .toEqual({ clicks: 3, perBar: 3, intervalFrames: 24_000 });
  // The playhead waits at the loop start during the 1.5 s count-in, then the song plays.
  await expect.poll(async () => (await debug(page))?.status, { timeout: 30_000 }).toBe("playing");
  await expect
    .poll(async () => (await debug(page))?.clicks ?? 0, { timeout: 30_000 })
    .toBeGreaterThan(3);
  const s = await debug(page);
  if (!s?.loop) throw new Error("loop lost");
  expect(s.loop.start).toBe(4 * 48_000);

  // Loop options (long-press on phones, right-click on desktop): count-in every repeat.
  const loopButton = page.getByTestId("loop-toggle").first();
  if (phone) {
    const box = await loopButton.boundingBox();
    if (!box) throw new Error("no loop button");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    // Held until the long-press opens the menu.
    await expect(page.getByTestId("loop-option-every-repeat")).toBeVisible();
    await page.mouse.up();
  } else {
    await loopButton.click({ button: "right" });
  }
  await page.getByTestId("loop-option-every-repeat").click();
  await closeMenu(page);
  await expect
    .poll(async () => (await debug(page))?.repeatCountIn ?? null)
    .toEqual({ clicks: 3, perBar: 3, intervalFrames: 24_000 });
  expect((await debug(page))?.loop).not.toBeNull(); // the long-press did not toggle the loop
  // A repeat plays its count-in: the countdown state shows up at the wrap.
  await expect
    .poll(async () => (await debug(page))?.countIn !== null, { timeout: 60_000, intervals: [50] })
    .toBe(true);
  await page.getByTestId("rehearse-play").click();
  await expect.poll(async () => (await debug(page))?.status).toBe("stopped");

  // --- Tempo change moves musical items; history restores the MIDI import. ---
  await page.getByTestId("tempo-button").click();
  await dialog.getByTestId("tempo-bpm").fill("60");
  await dialog.getByTestId("tempo-save").click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(async () => (await songMarkers(page, songId)).find((m) => m.name === "Chorus")?.startSec)
    .toBeCloseTo(8, 3);
  await page.getByTestId("tempo-button").click();
  await dialog.getByTestId("tempo-tab-history").click();
  await expect(dialog.getByTestId("tempo-revision")).toHaveCount(4);
  await dialog.getByTestId("tempo-restore").last().click(); // the oldest: the MIDI import
  await expect(page.getByTestId("song-tempo")).toContainText("90–140 BPM");
  await page.keyboard.press("Escape");

  if (phone) {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    expect(
      await page.evaluate(() => window.innerWidth === document.documentElement.clientWidth),
    ).toBe(true);
  } else {
    // Desktop keyboard (SPEC §11.4): C toggles the click, K the count-in.
    await page.locator("body").click({ position: { x: 1, y: 1 } });
    const before = (await debug(page))?.clickSettings.enabled;
    await page.keyboard.press("c");
    await expect.poll(async () => (await debug(page))?.clickSettings.enabled).toBe(!before);
    await page.keyboard.press("k");
    await expect.poll(async () => (await debug(page))?.clickSettings.countIn).toBe(false);
  }
});
