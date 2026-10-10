import { expect, test, type Page } from "@playwright/test";
import { generateFixtures, TONE_FILE } from "@bandroom/fixtures";
import { isMobile, loginAsNewUser, openMixer, uniqueUsername } from "./helpers";

test.beforeAll(async () => {
  await generateFixtures();
});

interface DebugState {
  status: string;
  position: number;
  length: number;
  underruns: number;
  loop: { start: number; end: number } | null;
  loopCached: boolean;
  lap: number;
}

/** Engine state exposed by the Rehearse controller (SPEC §20: debug state for e2e). */
const debug = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as { __bandroomRehearse?: { state: () => DebugState } }
      ).__bandroomRehearse?.state() ?? null,
  );

/** Drags across the detail timeline's ruler strip from `a` to `b` (fractions of its width). */
async function dragRuler(page: Page, a: number, b: number) {
  const detail = page.getByTestId("timeline-detail");
  // Phones: the Mixer's tools and headers push the ruler below the fixed transport.
  await detail.evaluate((el) => {
    el.scrollIntoView({ block: "center" });
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

test("Markers: add a section, loop it with two taps, frame-accurate loop cache", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  const phone = isMobile(testInfo);
  await loginAsNewUser(page, request, testInfo, "member");

  await page.goto("library");
  await page.getByTestId("new-project").click();
  await page.getByLabel("Name").fill(`Markers ${uniqueUsername(testInfo)}`);
  await page.getByTestId("create-project-submit").click();
  await page.getByTestId("project-settings-tab").waitFor();
  await page.getByTestId("new-song").click();
  await page.getByLabel("Title", { exact: true }).fill("Loop me");
  await page.getByTestId("create-song-submit").click();
  await page.getByTestId("song-row").filter({ hasText: "Loop me" }).getByRole("link").click();

  await page.getByTestId("track-dropzone").locator('input[type="file"]').setInputFiles(TONE_FILE());
  const rows = page.getByTestId("track-row");
  await expect(rows).toHaveCount(1, { timeout: 20_000 });
  await expect(rows.filter({ hasText: "kHz" })).toHaveCount(1, { timeout: 180_000 });

  await openMixer(page);
  await expect.poll(async () => (await debug(page))?.status, { timeout: 30_000 }).toBe("stopped");
  // Nothing to loop yet: no selection and no section under the playhead.
  // (Enabled for its long-press options, but marked disabled for the loop itself.)
  await expect(page.getByTestId("loop-toggle").first()).toHaveAttribute("aria-disabled", "true");

  // Select a range in the ruler and save it as a section ("Chorus" preset).
  await dragRuler(page, 0.2, 0.6);
  await expect(page.getByTestId("selection")).toBeVisible();
  await page.getByTestId("save-as-section").click();
  const editor = page.getByTestId("marker-editor");
  await editor.getByTestId("section-presets").getByText("Chorus", { exact: true }).click();
  await expect(editor.getByTestId("marker-name")).toHaveValue("Chorus");
  await editor.getByTestId("marker-save").click();
  await expect(page.getByTestId("section-item")).toHaveCount(1);
  // The section pills are off by default (SPEC §31.3): the Sections toggle shows them.
  await expect(page.getByTestId("section-chip")).toHaveCount(0);
  await page.getByTestId("section-pills-toggle").click();
  const chip = page.getByTestId("section-chip").filter({ hasText: "Chorus" });
  await expect(chip).toBeVisible();

  // Two taps on the pill loop the section (SPEC §11.1 two-tap rule).
  await page.getByTestId("selection-clear").click();
  await expect.poll(async () => (await debug(page))?.loop ?? null).toBeNull();
  await chip.dblclick();
  await expect(chip).toHaveAttribute("data-looped", "true");
  await expect.poll(async () => (await debug(page))?.loop ?? null).not.toBeNull();
  const s = await debug(page);
  if (!s?.loop) throw new Error("no loop");
  expect(s.loop.start / s.length).toBeGreaterThan(0.15);
  expect(s.loop.end / s.length).toBeLessThan(0.65);
  expect(s.loopCached).toBe(true); // 4 s × 1 track fits the 64 MB loop cache
  // The playhead jumped to the loop start.
  expect(Math.abs(s.position - s.loop.start)).toBeLessThan(48_000);

  // Play: the loop repeats inside its range without underruns.
  await page.getByTestId("rehearse-play").click();
  await expect.poll(async () => (await debug(page))?.status, { timeout: 30_000 }).toBe("playing");
  await expect
    .poll(async () => (await debug(page))?.lap ?? 0, { timeout: 60_000 })
    .toBeGreaterThan(1);
  for (let i = 0; i < 5; i++) {
    const d = await debug(page);
    if (!d?.loop) throw new Error("loop lost");
    expect(d.position).toBeGreaterThanOrEqual(d.loop.start - 1);
    expect(d.position).toBeLessThanOrEqual(d.loop.end + 1);
    // Sample again once the playhead has moved on.
    await expect.poll(async () => (await debug(page))?.position).not.toBe(d.position);
  }
  expect((await debug(page))?.underruns).toBe(0);

  // Loop off while playing keeps playing (no rebuffer) and plays past the old loop end.
  await page.getByTestId("loop-toggle").first().click();
  await expect.poll(async () => (await debug(page))?.loop === null).toBe(true);
  expect((await debug(page))?.status).toBe("playing");
  await expect
    .poll(
      async () => {
        const d = await debug(page);
        return d ? d.position / d.length : 0;
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0.62);

  // A marker at the playhead, then previous/next navigation between boundaries.
  await page.getByTestId("add-marker").click();
  await expect(page.getByTestId("marker-item")).toHaveCount(1);
  await page.getByTestId("rehearse-play").click();
  await expect.poll(async () => (await debug(page))?.status).toBe("stopped");
  // Marker → section end → section start (each press goes one boundary back).
  const ratio = async () => {
    const d = await debug(page);
    return d ? d.position / d.length : 1;
  };
  for (let i = 0; i < 4 && Math.abs((await ratio()) - 0.2) > 0.05; i++) {
    const before = await ratio();
    await page.getByTestId("go-prev").click();
    await expect.poll(ratio).toBeLessThan(before);
  }
  expect(Math.abs((await ratio()) - 0.2)).toBeLessThan(0.05); // the section start
  await page.getByTestId("go-next").click();
  await expect.poll(async () => Math.abs((await ratio()) - 0.6)).toBeLessThan(0.05); // its end

  // Delete the section from its editor, then undo.
  await page.getByTestId("section-item").click();
  await page.getByTestId("edit-picked").click();
  await page.getByTestId("marker-delete").click();
  await expect(page.getByTestId("section-item")).toHaveCount(0);
  await page.getByTestId("marker-undo").click();
  await expect(page.getByTestId("section-item")).toHaveCount(1);

  // Markers persist for other visits and the phone layout does not overflow at its width.
  await page.reload();
  await expect(page.getByTestId("section-chip")).toHaveCount(1, { timeout: 30_000 });
  if (phone) {
    // Polled: the layout settles while the song loads.
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      )
      .toBeLessThanOrEqual(0);
    expect(
      await page.evaluate(() => window.innerWidth === document.documentElement.clientWidth),
    ).toBe(true);
  } else {
    // Desktop keyboard: L loops the section under the playhead, Escape clears.
    await expect.poll(async () => (await debug(page))?.status, { timeout: 30_000 }).toBe("stopped");
    await page.getByTestId("section-chip").click();
    await page.locator("body").click({ position: { x: 1, y: 1 } });
    await page.keyboard.press("l");
    await expect.poll(async () => (await debug(page))?.loop ?? null).not.toBeNull();
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await debug(page))?.loop === null).toBe(true);
  }
});
