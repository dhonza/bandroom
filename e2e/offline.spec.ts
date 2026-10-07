import { expect, test, type Page } from "@playwright/test";
import { generateFixtures, TONE_FILE } from "@bandroom/fixtures";
import { closeMixer, isMobile, loginAsNewUser, openMixer, uniqueUsername } from "./helpers";

test.use({ serviceWorkers: "allow" });

test.beforeAll(async () => {
  await generateFixtures();
});

interface DebugState {
  status: string;
  position: number;
  length: number;
  tracks: { id: string }[];
  errors: Record<string, string>;
}

const debug = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as { __bandroomRehearse?: { state: () => DebugState } }
      ).__bandroomRehearse?.state() ?? null,
  );

/** The service worker controls the page (it claims clients on its first activation). */
async function waitForServiceWorker(page: Page) {
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
    timeout: 60_000,
  });
}

/** A project with one song made from a dropped file (one track), processed. */
async function songWithMix(page: Page, name: string): Promise<{ songPath: string }> {
  await page.goto("library");
  await page.getByTestId("new-project").click();
  await page.getByLabel("Name").fill(name);
  await page.getByTestId("create-project-submit").click();
  await page.getByTestId("project-settings-tab").waitFor();
  await page
    .getByTestId("folder-dropzone")
    .locator('input[type="file"]')
    .setInputFiles(TONE_FILE());
  const row = page.getByTestId("song-row").filter({ hasText: "tone_48000_s16_stereo" });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByRole("link").click();
  // One worker processes every test's uploads on this server: wait for the track.
  await closeMixer(page, 240_000);
  return { songPath: new URL(page.url()).pathname };
}

async function makeOffline(page: Page) {
  await page.getByTestId("offline-button").click();
  const modal = page.getByTestId("offline-modal");
  await expect(modal.getByTestId("offline-estimate")).toContainText("About", { timeout: 30_000 });
  await modal.getByTestId("offline-download").click();
  await expect(page.getByTestId("offline-button")).toHaveAttribute("data-status", "ready", {
    timeout: 120_000,
  });
}

/** Opens the song again while offline: the app shell, API answers and audio from the worker. */
async function reopen(page: Page) {
  await page.reload();
  await expect(page.getByRole("heading", { level: 2, name: "tone_48000_s16_stereo" })).toBeVisible({
    timeout: 30_000,
  });
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

test("Offline song: the Player with the Mixer closed and open in airplane mode, comment and marker sync on reconnect", async ({
  page,
  context,
  request,
  browserName,
}, testInfo) => {
  // Playwright's WebKit blocks every request of an offline context before the service worker can
  // answer it (even precached files), so airplane mode is covered in Chromium (desktop, Pixel,
  // sub-path); WebKit gets the cache checks of the next test, the iPhone PWA is a device test.
  test.skip(browserName === "webkit", "offline emulation bypasses service workers in WebKit");
  test.setTimeout(420_000);
  const phone = isMobile(testInfo);
  await loginAsNewUser(page, request, testInfo, "member");
  const { songPath } = await songWithMix(page, `Offline ${uniqueUsername(testInfo)}`);
  const songId = songPath.split("/").at(-1) ?? "";
  await waitForServiceWorker(page);
  await makeOffline(page);

  // --- Airplane mode: the app, the song and its audio come from this device. ---
  await context.setOffline(true);
  await reopen(page);
  await expect(page.getByRole("heading", { level: 2, name: "tone_48000_s16_stereo" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("offline-indicator")).toBeVisible();
  await expect(page.getByTestId("offline-button")).toHaveAttribute("data-status", "ready");

  // The Player plays the engine from the cache with the Mixer closed (SPEC §27.6) …
  await expect(page.getByTestId("mixer-toggle")).toHaveAttribute("aria-pressed", "false");
  const closed = page.getByTestId("rehearse-panel");
  await expect.poll(async () => (await debug(page))?.status, { timeout: 30_000 }).toBe("stopped");
  await closed.getByTestId("rehearse-play").click();
  await expect.poll(async () => (await debug(page))?.status, { timeout: 30_000 }).toBe("playing");
  const p0 = (await debug(page))?.position ?? 0;
  await expect
    .poll(async () => (await debug(page))?.position ?? 0, { timeout: 20_000 })
    .toBeGreaterThan(p0 + 12_000);
  await closed.getByTestId("rehearse-play").click();
  await expect.poll(async () => (await debug(page))?.status, { timeout: 30_000 }).toBe("stopped");

  // … and open (decoder worker: full and Range reads from the cache).
  await openMixer(page);
  await expect.poll(async () => (await debug(page))?.status, { timeout: 30_000 }).toBe("stopped");
  expect((await debug(page))?.tracks).toHaveLength(1);
  await page.getByTestId("rehearse-play").click();
  await expect.poll(async () => (await debug(page))?.status, { timeout: 30_000 }).toBe("playing");
  const p1 = (await debug(page))?.position ?? 0;
  await expect
    .poll(async () => (await debug(page))?.position ?? 0, { timeout: 20_000 })
    .toBeGreaterThan(p1 + 12_000);
  const detail = page.getByTestId("timeline-detail");
  await detail.evaluate((el) => {
    el.scrollIntoView({ block: "center", behavior: "instant" });
  });
  const box = await detail.boundingBox();
  if (!box) throw new Error("no timeline");
  await detail.click({ position: { x: box.width * 0.6, y: 10 } });
  await expect
    .poll(async () => {
      const s = await debug(page);
      return s ? s.position / s.length : 0;
    })
    .toBeGreaterThan(0.5);
  expect((await debug(page))?.errors).toEqual({});
  await page.getByTestId("rehearse-play").click();

  // A marker added offline shows at once and waits in the outbox.
  await page.getByTestId("add-marker").click();
  await expect(page.getByTestId("marker-item")).toHaveCount(1, { timeout: 20_000 });

  // A comment written offline waits in the outbox (also across a reload).
  await page.getByTestId("comment-at-playhead").click();
  const panel = page.getByTestId("comments-panel");
  await panel.getByTestId("comment-input").fill("Written in airplane mode");
  await panel.getByTestId("comment-input-submit").click();
  const item = panel.getByTestId("comment-item").filter({ hasText: "Written in airplane mode" });
  await expect(item).toBeVisible();
  await expect(item.getByTestId("comment-pending")).toBeVisible();
  const serverComments = async () =>
    (
      (await (await page.request.get(`api/v1/songs/${songId}/comments`)).json()) as {
        comments: { body: string }[];
      }
    ).comments.map((c) => c.body);
  expect(await serverComments()).toEqual([]);
  expect(
    ((await (await page.request.get(`api/v1/songs/${songId}/markers`)).json()) as { markers: [] })
      .markers,
  ).toEqual([]);
  if (phone) await noHorizontalOverflow(page);

  await page.keyboard.press("Escape");
  await reopen(page);
  await expect(page.getByTestId("marker-item")).toHaveCount(1);
  await page.getByTestId("open-comments").click();
  await expect(page.getByTestId("comments-panel").getByTestId("comment-pending")).toBeVisible();

  // --- Back online: the outbox is sent, the comment is on the server once. ---
  await context.setOffline(false);
  await expect(page.getByTestId("offline-indicator")).toBeHidden({ timeout: 30_000 });
  await expect.poll(serverComments, { timeout: 30_000 }).toEqual(["Written in airplane mode"]);
  const serverMarkers = async () =>
    (
      (await (await page.request.get(`api/v1/songs/${songId}/markers`)).json()) as {
        markers: unknown[];
      }
    ).markers.length;
  await expect.poll(serverMarkers, { timeout: 30_000 }).toBe(1);
  await expect(page.getByTestId("comments-panel").getByTestId("comment-pending")).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(
    page.getByTestId("comments-panel").getByTestId("comment-item").filter({
      hasText: "Written in airplane mode",
    }),
  ).toHaveCount(1);
});

test("Offline project, Range answers from the cache, Offline page, logout cleanup", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(420_000);
  const phone = isMobile(testInfo);
  await loginAsNewUser(page, request, testInfo, "member");
  const projectName = `Offline project ${uniqueUsername(testInfo)}`;
  const { songPath } = await songWithMix(page, projectName);
  await waitForServiceWorker(page);

  // The whole project, from its page.
  await page.getByRole("link", { name: `← ${projectName}` }).click();
  await page.getByTestId("offline-button").click();
  await expect(page.getByTestId("offline-estimate")).toContainText("1 song", { timeout: 30_000 });
  await page.getByTestId("offline-download").click();
  await expect(page.getByTestId("offline-button")).toHaveAttribute("data-status", "ready", {
    timeout: 120_000,
  });
  await expect(page.getByTestId("song-offline-badge")).toHaveCount(1);
  await page.goto(songPath.replace(/^\/bandroom/, "").replace(/^\//, ""));
  await expect(page.getByTestId("offline-button")).toHaveAttribute("data-status", "project");

  // The worker answers the engine's and <audio>'s requests from the cached blobs: whole files,
  // open and closed ranges, and 416 outside the file.
  const songId = songPath.split("/").at(-1) ?? "";
  const reads = await page.evaluate(async (id) => {
    const res = await fetch(`api/v1/songs/${id}/offline`);
    const { song } = (await res.json()) as { song: { blobs: { hash: string; bytes: number }[] } };
    const blob = song.blobs.reduce((a, b) => (b.bytes > a.bytes ? b : a));
    const read = async (range?: string) => {
      const r = await fetch(
        `api/v1/blobs/${blob.hash}`,
        range ? { headers: { Range: range } } : {},
      );
      return {
        status: r.status,
        hit: r.headers.get("x-bandroom-cache"),
        range: r.headers.get("content-range"),
        length: (await r.arrayBuffer()).byteLength,
      };
    };
    return {
      size: blob.bytes,
      whole: await read(),
      open: await read("bytes=0-"),
      closed: await read("bytes=100-1099"),
      tail: await read(`bytes=${blob.bytes - 10}-`),
      outside: await read(`bytes=${blob.bytes}-`),
    };
  }, songId);
  expect(reads.whole).toMatchObject({ status: 200, hit: "1", length: reads.size });
  expect(reads.open).toMatchObject({ status: 206, hit: "1", length: reads.size });
  expect(reads.closed).toMatchObject({
    status: 206,
    range: `bytes 100-1099/${reads.size}`,
    length: 1000,
  });
  expect(reads.tail).toMatchObject({ status: 206, length: 10 });
  expect(reads.outside.status).toBe(416);

  // Storage management.
  await page.goto("offline");
  const items = page.getByTestId("offline-item");
  await expect(items).toHaveCount(1);
  await expect(items).toContainText(projectName);
  await expect(items.getByTestId("offline-item-status")).toHaveText("Up to date");
  await expect(page.getByTestId("offline-total")).not.toContainText(" 0 ");
  if (phone) await noHorizontalOverflow(page);
  await items.getByTestId("offline-item-update").click();
  await expect(items).toHaveAttribute("data-status", "ready", { timeout: 60_000 });

  const userData = () =>
    page.evaluate(async () => {
      const cacheNames = (await caches.keys()).filter((n) => /bandroom-(blobs|pinned)-/.test(n));
      const sizes = await Promise.all(
        cacheNames.map(async (n) => (await (await caches.open(n)).keys()).length),
      );
      const dbs = (await indexedDB.databases()).map((d) => d.name ?? "");
      return {
        entries: sizes.reduce((a, b) => a + b, 0),
        dbs: dbs.filter((n) => n.startsWith("bandroom-offline-")).length,
      };
    });
  expect((await userData()).entries).toBeGreaterThan(5);

  // Logout warns and clears this user's offline data.
  if (phone) {
    await page.goto("me");
    await page.getByRole("button", { name: "Log out" }).click();
  } else {
    await page.getByTestId("user-menu").click();
    await page.getByTestId("logout").click();
  }
  const prompt = page.getByTestId("logout-prompt");
  await expect(prompt).toContainText(projectName);
  await prompt.getByTestId("logout-confirm").click();
  await expect(page).toHaveURL(/\/login/, { timeout: 30_000 });
  await expect.poll(async () => (await userData()).entries).toBe(0);
  expect((await userData()).dbs).toBe(0);
});
