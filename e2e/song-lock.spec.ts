import { expect, test, type Page } from "@playwright/test";
import { generateFixtures, TONE_FILE } from "@bandroom/fixtures";
import { loginAsNewUser, uniqueUsername } from "./helpers";

/**
 * M19 group D: the song lock (SPEC §25.12) and the default mix while the song's mix is being
 * prepared (SPEC §25.5).
 */

test.beforeAll(async () => {
  await generateFixtures();
});

const CSRF = { "X-Requested-With": "bandroom" };

interface DebugState {
  status: string;
  position: number;
}
const debug = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as { __bandroomRehearse?: { state: () => DebugState } }
      ).__bandroomRehearse?.state() ?? null,
  );

/** A new project and song (the creator manages both) with one ingested track. */
async function songWithTrack(page: Page, testInfo: Parameters<typeof uniqueUsername>[0]) {
  const res = await page.request.post("api/v1/projects", {
    headers: CSRF,
    data: { name: `Lock ${uniqueUsername(testInfo)}` },
  });
  const { project } = (await res.json()) as { project: { id: string } };
  const songRes = await page.request.post(`api/v1/projects/${project.id}/songs`, {
    headers: CSRF,
    data: { title: "Lock me" },
  });
  const { song } = (await songRes.json()) as { song: { id: string } };
  await page.goto(`songs/${song.id}`);
  await page.getByTestId("track-dropzone").locator('input[type="file"]').setInputFiles(TONE_FILE());
  await expect(page.getByTestId("track-row").filter({ hasText: "kHz" })).toHaveCount(1, {
    timeout: 180_000,
  });
  return song.id;
}

const markerCount = async (page: Page, songId: string) =>
  (
    (await (await page.request.get(`api/v1/songs/${songId}/markers`)).json()) as {
      markers: unknown[];
    }
  ).markers.length;

test("Song lock: frozen controls, refused changes, live for other tabs, unlock", async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  await loginAsNewUser(page, page.request, testInfo, "member");
  const songId = await songWithTrack(page, testInfo);
  const addMarker = page.getByTestId("add-marker");
  await expect(addMarker).toBeEnabled({ timeout: 30_000 });

  // A second tab on the same song follows the lock live (SSE).
  const other = await page.context().newPage();
  await other.goto(`songs/${songId}`);
  await expect(other.getByTestId("add-marker")).toBeEnabled({ timeout: 30_000 });

  const toggle = page.getByTestId("song-lock-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("song-lock-banner")).toBeVisible();
  await expect(addMarker).toBeDisabled();
  await expect(page.getByTestId("comment-at-playhead")).toBeDisabled();
  await expect(other.getByTestId("song-lock-banner")).toBeVisible({ timeout: 15_000 });
  await expect(other.getByTestId("add-marker")).toBeDisabled();

  // The `M` shortcut does nothing; the server refuses a marker anyway.
  await page.locator("body").press("m");
  const refused = await page.request.post(`api/v1/songs/${songId}/markers`, {
    headers: CSRF,
    data: { type: "marker", name: "Sneaky", color: "red", startSec: 1 },
  });
  expect(refused.status()).toBe(409);
  expect(((await refused.json()) as { code: string }).code).toBe("SONG_LOCKED");
  expect(await markerCount(page, songId)).toBe(0);

  // Unlock: everything works again, in both tabs.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("song-lock-banner")).toHaveCount(0);
  await expect(other.getByTestId("song-lock-banner")).toHaveCount(0, { timeout: 15_000 });
  await addMarker.click();
  await expect.poll(() => markerCount(page, songId), { timeout: 15_000 }).toBe(1);
  await expect(page.getByTestId("comment-at-playhead")).toBeEnabled();
  await other.close();
});

test("Default mix: the closed Mixer plays the tracks until the mix is ready", async ({
  page,
}, testInfo) => {
  test.setTimeout(720_000);
  await loginAsNewUser(page, page.request, testInfo, "member");
  await songWithTrack(page, testInfo);

  // No mix yet (60 s debounce after the upload): the default mix plays in the closed Mixer.
  const panel = page.getByTestId("default-mix-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("default-mix-note")).toBeVisible();
  await expect(page.getByTestId("mixer-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect.poll(async () => (await debug(page))?.status, { timeout: 30_000 }).toBe("stopped");
  await page.getByTestId("rehearse-play").click();
  await expect.poll(async () => (await debug(page))?.status, { timeout: 30_000 }).toBe("playing");
  await page.getByTestId("rehearse-play").click();
  await expect.poll(async () => (await debug(page))?.status, { timeout: 30_000 }).toBe("stopped");

  // Once the automatic mix is rendered, the mix player takes over. One worker processes every
  // test's uploads first (the mix queues behind them), so under full-suite load this takes minutes.
  await expect(page.getByTestId("listen-panel")).toBeVisible({ timeout: 480_000 });
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId("listen-play")).toBeEnabled();
});
