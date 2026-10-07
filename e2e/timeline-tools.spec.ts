import { expect, test, type Page } from "@playwright/test";
import { generateFixtures, TONE_FILE } from "@bandroom/fixtures";
import { isMobile, loginAsNewUser, openMixer, TAP_NAME, uniqueUsername } from "./helpers";

/**
 * M19 group C (SPEC §25.6–§25.10): version gain, track colours, lane height, zoom to loop and
 * double click / double tap to edit markers and sections.
 */

test.beforeAll(async () => {
  await generateFixtures();
});

const CSRF = { "X-Requested-With": "bandroom" };

/** Drags across the detail timeline's ruler from `a` to `b` (fractions of its width). */
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

const view = async (page: Page) =>
  ((await page.getByTestId("timeline-detail").getAttribute("data-view")) ?? "0,0")
    .split(",")
    .map(Number) as [number, number];

test("Timeline tools: version gain, colour, lane height, zoom to loop, double tap to edit", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const phone = isMobile(testInfo);
  await loginAsNewUser(page, page.request, testInfo, "member");
  const res = await page.request.post("api/v1/projects", {
    headers: CSRF,
    data: { name: `Tools ${uniqueUsername(testInfo)}` },
  });
  const { project } = (await res.json()) as { project: { id: string } };
  const songRes = await page.request.post(`api/v1/projects/${project.id}/songs`, {
    headers: CSRF,
    data: { title: "Tools" },
  });
  const { song } = (await songRes.json()) as { song: { id: string } };
  await page.goto(`songs/${song.id}`);
  await page.getByTestId("track-dropzone").locator('input[type="file"]').setInputFiles(TONE_FILE());
  const rows = page.getByTestId("track-row");
  await expect(rows.filter({ hasText: "kHz" })).toHaveCount(1, { timeout: 180_000 });
  const tracks = async () =>
    (
      (await (await page.request.get(`api/v1/songs/${song.id}/tracks`)).json()) as {
        tracks: { name: string; color: string; current: { gainDb: number } }[];
      }
    ).tracks;
  // A name without an instrument: the first palette colour the song does not use.
  expect((await tracks())[0]?.color).toBe("red");

  await openMixer(page);
  const lanes = page.locator("canvas[data-lane-scales]");
  await expect(lanes).toHaveAttribute("data-lane-scales", "1.000");

  // Version gain: typed in dB, applied to the waveform and saved (SPEC §25.6); then the colour.
  const strip = page.getByTestId("track-strip");
  await strip.getByTestId("track-settings").click(TAP_NAME);
  const settings = page.getByTestId("track-settings-panel");
  const gain = page.getByTestId("version-gain");
  await gain.fill("-6");
  await gain.press("Enter");
  await expect(lanes).toHaveAttribute("data-lane-scales", "0.501");
  await expect.poll(async () => (await tracks())[0]?.current.gainDb).toBe(-6);
  // Phones: the narrow header keeps the version details in its settings popover.
  await expect((phone ? settings : strip).getByTestId("version-gain-badge")).toHaveText("-6 dB");
  if (phone) {
    await settings.getByTestId("track-color-palette").getByRole("radio", { name: "Teal" }).click();
  } else {
    await page.keyboard.press("Escape");
    await strip.getByTestId("track-color").click();
    await page.getByTestId("track-color-palette").getByRole("radio", { name: "Teal" }).click();
  }
  await expect.poll(async () => (await tracks())[0]?.color).toBe("teal");
  // The 16-colour palette (SPEC §11.5); on phones it sits in the settings popover.
  if (phone) {
    await expect(settings.getByTestId("track-color-palette").getByRole("radio")).toHaveCount(16);
    await page.keyboard.press("Escape");
    await expect(settings).toBeHidden();
  }

  // Lane height (SPEC §25.9): taller, remembered after a reload.
  const detail = page.getByTestId("timeline-detail");
  const before = Number(await detail.getAttribute("data-lane-height"));
  await page.getByTestId("lanes-taller").click();
  await expect
    .poll(async () => Number(await detail.getAttribute("data-lane-height")))
    .toBeGreaterThan(before);
  const taller = Number(await detail.getAttribute("data-lane-height"));

  // Zoom to loop (SPEC §25.8): disabled without a selection, then shows it with margins.
  await expect(page.getByTestId("zoom-to-loop")).toBeDisabled();
  await dragRuler(page, 0.4, 0.6);
  await expect(page.getByTestId("selection")).toBeVisible();
  await page.getByTestId("zoom-to-loop").click();
  await expect.poll(async () => (await view(page))[1] - (await view(page))[0]).toBeLessThan(5);
  const [from, to] = await view(page);
  expect(from).toBeGreaterThan(2);
  expect(to).toBeLessThan(8);

  // Save the selection as a section, then double click / double tap it to edit (SPEC §25.7).
  await page.getByTestId("save-as-section").click();
  const editor = page.getByTestId("marker-editor");
  // The modal's root has no box of its own: check its fields.
  const editorName = editor.getByTestId("marker-name");
  await editorName.fill("Bridge");
  await editor.getByTestId("marker-save").click();
  await expect(editorName).toBeHidden();
  const item = page.getByTestId("section-item");
  await expect(item).toHaveCount(1);
  if (phone) {
    await item.tap();
    await item.tap();
  } else {
    await item.dblclick();
  }
  await expect(editorName).toHaveValue("Bridge");
  await page.keyboard.press("Escape");
  await expect(editorName).toBeHidden();

  if (!phone) {
    // Right click on the section: the timeline menu offers "Edit".
    await item.click({ button: "right" });
    await page.getByTestId("menu-edit-item").click();
    await expect(editorName).toHaveValue("Bridge");
    await page.keyboard.press("Escape");
    await expect(editorName).toBeHidden();
    // Z after "Fit": back to the loop.
    await page.getByRole("button", { name: "Show whole song" }).click();
    await expect.poll(async () => (await view(page))[1] - (await view(page))[0]).toBeGreaterThan(9);
    await page.locator("body").click({ position: { x: 1, y: 1 } });
    await page.keyboard.press("z");
    await expect.poll(async () => (await view(page))[1] - (await view(page))[0]).toBeLessThan(5);
  }

  if (phone) return;
  // Desktop: the lane height (per device) and the version gain survive a reload.
  await page.reload();
  await openMixer(page);
  await expect(page.getByTestId("timeline-detail")).toHaveAttribute(
    "data-lane-height",
    String(taller),
  );
  await expect(page.locator("canvas[data-lane-scales]")).toHaveAttribute(
    "data-lane-scales",
    "0.501",
  );
});
