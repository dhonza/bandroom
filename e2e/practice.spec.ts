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
  errors: Record<string, string>;
  practice: { rate: number; semitones: number; cents: number };
  enginePractice: { rate: number; semitones: number; quality: string } | null;
}

const debug = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as { __bandroomRehearse?: { state: () => DebugState } }
      ).__bandroomRehearse?.state() ?? null,
  );

/**
 * Opens the Practice form: the transport button (desktop); on phones the full-screen panel from
 * the readout's Practice button or from "⋯".
 */
async function openPractice(page: Page, phone: boolean, via: "button" | "menu" = "button") {
  if (phone && via === "menu") {
    await page.getByRole("button", { name: "Playback options" }).last().click();
    await page.getByTestId("menu-practice").click();
  } else if (phone) {
    await page.getByTestId("practice-phone-button").click();
  } else {
    await page.getByTestId("practice-button").click();
  }
  await expect(page.getByTestId("practice-form")).toBeVisible();
}

test("Practice: slower and transposed, plays and persists (SPEC §30)", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(600_000);
  const phone = isMobile(testInfo);
  await loginAsNewUser(page, request, testInfo, "member");

  await page.goto("library");
  await page.getByTestId("new-project").click();
  await page.getByLabel("Name").fill(`Practice ${uniqueUsername(testInfo)}`);
  await page.getByTestId("create-project-submit").click();
  await page.getByTestId("project-settings-tab").waitFor();
  await page.getByTestId("new-song").click();
  await page.getByLabel("Title", { exact: true }).fill("Slow tune");
  await page.getByTestId("create-song-submit").click();
  await page.getByTestId("song-row").filter({ hasText: "Slow tune" }).getByRole("link").click();
  await page.getByTestId("track-dropzone").locator('input[type="file"]').setInputFiles(TONE_FILE());
  const rows = page.getByTestId("track-row");
  await expect(rows.filter({ hasText: "kHz" })).toHaveCount(1, { timeout: 180_000 });

  await openMixer(page);
  await expect.poll(async () => (await debug(page))?.status, { timeout: 30_000 }).toBe("stopped");

  await openPractice(page, phone);
  await page.getByTestId("practice-preset-75").click();
  await page.getByTestId("practice-pitch-down").click();
  await page.getByTestId("practice-pitch-down").click();
  await expect(page.getByTestId("practice-speed-value")).toHaveText("75 %");
  await expect
    .poll(async () => (await debug(page))?.enginePractice)
    .toMatchObject({
      rate: 0.75,
      semitones: -2,
    });
  await page.keyboard.press("Escape");
  if (phone) await expect(page.getByTestId("practice-phone-button")).toHaveText("75 % · −2");
  else await expect(page.getByTestId("practice-button")).toHaveText("75 % · −2 st");

  // Plays through the stretcher: the position moves on, without errors.
  const saved = page.waitForResponse(
    (res) =>
      res.request().method() === "PUT" &&
      /\/songs\/[^/]+\/mixer$/.test(new URL(res.url()).pathname) &&
      (res.request().postDataJSON() as { state: { practice?: { rate?: number } } }).state.practice
        ?.rate === 0.75,
    { timeout: 30_000 },
  );
  await page.getByTestId("rehearse-play").click();
  await expect.poll(async () => (await debug(page))?.status, { timeout: 30_000 }).toBe("playing");
  const p1 = (await debug(page))?.position ?? 0;
  await expect.poll(async () => (await debug(page))?.position ?? 0).toBeGreaterThan(p1 + 12_000);
  expect((await debug(page))?.errors).toEqual({});
  await page.getByTestId("rehearse-play").click();

  // Personal and per song: kept after a reload.
  await saved;
  await page.reload();
  await expect(page.getByTestId("rehearse-panel")).toBeVisible();
  await expect
    .poll(async () => (await debug(page))?.practice, { timeout: 30_000 })
    .toEqual({ rate: 0.75, semitones: -2, cents: 0 });

  // Bounce a practice version (desktop: the worker stretches with the same WASM, SPEC §30.7).
  if (!phone) {
    const length = (await debug(page))?.length ?? 0;
    expect(length).toBeGreaterThan(0);
    await page.getByTestId("mixer-bounce").click();
    await expect(page.getByTestId("bounce-applyPractice")).toBeChecked();
    await expect(page.getByTestId("bounce-title")).toHaveValue("Slow tune (75 %, −2 st)");
    await page.getByTestId("bounce-submit").click();
    await page.getByTestId("bounce-open").click();
    await expect(page.getByTestId("song-title")).toHaveText("Slow tune (75 %, −2 st)");
    await expect(page.getByTestId("track-row").filter({ hasText: "kHz" })).toHaveCount(1, {
      timeout: 420_000,
    });
    // A new song plays at the original speed: the bounce is 1 / 0.75 as long.
    await expect
      .poll(async () => (await debug(page))?.length ?? 0, { timeout: 60_000 })
      .toBeGreaterThan(length / 0.75 - 4800);
    expect((await debug(page))?.length ?? 0).toBeLessThan(length / 0.75 + 4800);
    await page.goBack();
    await expect(page.getByTestId("rehearse-panel")).toBeVisible();
  }

  // Back to the original (phones: from "⋯"; the button is at the end of the scrolling panel).
  await openPractice(page, phone, "menu");
  const reset = page.getByTestId("practice-reset");
  await reset.scrollIntoViewIfNeeded();
  await reset.click();
  await expect
    .poll(async () => (await debug(page))?.enginePractice)
    .toMatchObject({
      rate: 1,
      semitones: 0,
    });
});
