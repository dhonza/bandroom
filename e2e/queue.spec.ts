import path from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { FIXTURES_DIR, generateFixtures } from "@bandroom/fixtures";
import { isMobile, loginAsNewUser, uniqueUsername } from "./helpers";

/**
 * The engine queue and the mini-player (SPEC §6.10, §27.4): "Play all" moves on to the next song
 * at the end, the song keeps playing across in-app navigation, the song page reattaches without a
 * reload, deleting the playing song stops it, a song row's play button starts the queue there,
 * another song's page does not take over what plays (or is paused in the mini-player) until its
 * Play is pressed, and a project link's
 * song rows and "Play all" use the same queue.
 */

test.beforeAll(async () => {
  await generateFixtures();
});

// Two 6 s files: the queue reaches the second song quickly.
const FILES = ["imp_48000_s16_stereo", "imp_44100_s16_stereo"];

interface DebugState {
  songId: string | null;
  open: boolean;
  previewSongId: string | null;
  queue: { songIds: string[]; index: number } | null;
  status: string;
  position: number;
  length: number;
}

const debug = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as { __bandroomRehearse?: { state: () => DebugState } }
      ).__bandroomRehearse?.state() ?? null,
  );

/** In-app navigation (a reload would end the audio session). */
async function goLibrary(page: Page, testInfo: TestInfo) {
  const nav = isMobile(testInfo)
    ? page.getByTestId("bottom-tab-bar")
    : page.getByTestId("desktop-nav");
  await nav.getByRole("link", { name: "Library" }).click();
  await expect(page).toHaveURL(/library$/);
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

/** A project with two songs from a folder drop, both processed; returns the queue order. */
async function projectWithTwoSongs(page: Page, name: string, files = FILES) {
  await page.goto("library");
  await page.getByTestId("new-project").click();
  await page.getByLabel("Name").fill(name);
  await page.getByTestId("create-project-submit").click();
  await page.getByTestId("project-settings-tab").waitFor();
  const projectId = /projects\/([^/?#]+)/.exec(page.url())?.[1] ?? "";
  await page
    .getByTestId("folder-dropzone")
    .locator('input[type="file"]')
    .setInputFiles(files.map((f) => path.join(FIXTURES_DIR, `${f}.wav`)));
  await expect(page.getByTestId("song-row")).toHaveCount(2, { timeout: 30_000 });
  // One worker processes every test's uploads on this server.
  let items: { songId: string; title: string; ready: boolean }[] = [];
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`api/v1/projects/${projectId}/queue`);
        items = ((await res.json()) as { items: typeof items }).items;
        return items.filter((i) => i.ready).length;
      },
      { timeout: 420_000, intervals: [2000] },
    )
    .toBe(2);
  return { projectId, items };
}

test("Play all advances, the mini-player plays on across pages, the song page reattaches", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(600_000);
  await loginAsNewUser(page, request, testInfo, "member");
  const { items } = await projectWithTwoSongs(page, `Queue ${uniqueUsername(testInfo)}`);
  const [first, second] = items;
  if (!first || !second) throw new Error("two songs expected");

  // "Play all" on the project page: the first song plays, the mini-player shows it.
  await page.getByRole("tab", { name: "Songs" }).click();
  await page.getByTestId("play-all").click();
  const mini = page.getByTestId("mini-player");
  await expect(mini.getByTestId("mini-title")).toHaveText(first.title, { timeout: 30_000 });
  await expect.poll(async () => (await debug(page))?.status, { timeout: 30_000 }).toBe("playing");
  expect((await debug(page))?.queue?.songIds).toEqual([first.songId, second.songId]);
  if (isMobile(testInfo)) await noHorizontalOverflow(page);

  // At the end of the 6 s song the second one plays.
  await expect
    .poll(async () => (await debug(page))?.songId, { timeout: 30_000 })
    .toBe(second.songId);
  await expect(mini.getByTestId("mini-title")).toHaveText(second.title);
  await expect.poll(async () => (await debug(page))?.status, { timeout: 30_000 }).toBe("playing");

  // Another page: the mini-player stays and the song keeps playing.
  await goLibrary(page, testInfo);
  await expect(mini).toBeVisible();
  const before = (await debug(page))?.position ?? 0;
  await expect.poll(async () => (await debug(page))?.position ?? 0).toBeGreaterThan(before);
  await expect(mini.getByTestId("mini-play")).toHaveAccessibleName("Pause");

  // Its page reattaches without a reload or a stop; the mini-player hides there.
  await mini.getByTestId("mini-open").click();
  await expect(page.getByTestId("song-title")).toHaveText(second.title);
  await expect(mini).toBeHidden();
  await expect(page.getByTestId("rehearse-play")).toHaveAccessibleName("Pause");
  expect((await debug(page))?.songId).toBe(second.songId);

  // It ends on its page (the last song: it stays there, stopped). Left stopped, it closes; the
  // first song's page then opens it in the engine (a queue of its own).
  await expect(page.getByTestId("rehearse-play")).toHaveAccessibleName("Play", {
    timeout: 30_000,
  });
  await page.getByRole("link", { name: /^←/ }).click();
  await page
    .getByTestId("song-row")
    .filter({ hasText: first.title })
    .getByRole("link")
    .first()
    .click();
  await expect(page.getByTestId("song-title")).toHaveText(first.title);
  await expect
    .poll(async () => (await debug(page))?.songId, { timeout: 30_000 })
    .toBe(first.songId);
  expect((await debug(page))?.queue?.index).toBe(0);
  await page.getByTestId("rehearse-play").click();
  await expect.poll(async () => (await debug(page))?.status, { timeout: 30_000 }).toBe("playing");

  // Leave it playing, pause from the mini-player (it stays), close it (it goes).
  await goLibrary(page, testInfo);
  await expect(mini.getByTestId("mini-title")).toHaveText(first.title);
  await mini.getByTestId("mini-play").click();
  await expect(mini.getByTestId("mini-play")).toHaveAccessibleName("Play");
  await mini.getByTestId("mini-close").click();
  await expect(mini).toBeHidden();
  expect((await debug(page))?.open).toBe(false);

  // A paused song left behind closes; deleting the playing song stops it with a note.
  await page.goBack();
  await expect(page.getByTestId("song-title")).toHaveText(first.title);
  await page.getByTestId("rehearse-play").click();
  await expect.poll(async () => (await debug(page))?.status, { timeout: 30_000 }).toBe("playing");
  await page.getByTestId("delete-song").click();
  await page.getByTestId("confirm-name").fill(first.title);
  await page.getByTestId("confirm-delete").click();
  await expect(page).toHaveURL(/projects\//, { timeout: 15_000 });
  await expect(page.getByText("The song was deleted, so playback stopped.")).toBeVisible();
  await expect(mini).toBeHidden();
  expect((await debug(page))?.status).not.toBe("playing");
});

test("A song row plays from there; another song's page leaves it playing until Play", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(600_000);
  await loginAsNewUser(page, request, testInfo, "member");
  // A 61 s song keeps playing while the other song's page is open.
  const { items } = await projectWithTwoSongs(page, `Rows ${uniqueUsername(testInfo)}`, [
    "long_44100_s24_stereo",
    "imp_48000_s16_stereo",
  ]);
  const long = items.find((i) => /^long/i.test(i.title));
  const short = items.find((i) => /^imp/i.test(i.title));
  if (!long || !short) throw new Error("two songs expected");
  await page.getByRole("tab", { name: "Songs" }).click();
  const rows = page.getByTestId("song-row");
  const longRow = rows.filter({ hasText: long.title });
  const longPlay = longRow.getByTestId("song-row-play");
  await expect(longPlay).toBeEnabled({ timeout: 30_000 });

  // 360 px: the rows keep their 44 px play buttons inside the screen, no sideways scroll.
  const size = page.viewportSize();
  await page.setViewportSize({ width: 360, height: 740 });
  await noHorizontalOverflow(page);
  for (const button of await page.getByTestId("song-row-play").all()) {
    const b = await button.boundingBox();
    expect(b?.width).toBeGreaterThanOrEqual(44);
    expect(b?.height).toBeGreaterThanOrEqual(44);
    expect((b?.x ?? 0) + (b?.width ?? 0)).toBeLessThanOrEqual(360);
  }
  if (size) await page.setViewportSize(size);

  // The row's play button starts the project queue at that song; the row shows it playing.
  await expect(longPlay).toHaveAccessibleName(`Play ${long.title}`);
  await longPlay.click();
  await expect.poll(async () => (await debug(page))?.status, { timeout: 30_000 }).toBe("playing");
  let d = await debug(page);
  expect(d?.songId).toBe(long.songId);
  expect(d?.queue?.songIds).toEqual(items.map((i) => i.songId));
  expect(d?.queue?.index).toBe(items.indexOf(long));
  await expect(longPlay).toHaveAccessibleName(`Pause ${long.title}`);
  await expect(longPlay).toHaveAttribute("data-playing", "true");
  // Tapping it again pauses, and again resumes.
  await longPlay.click();
  await expect(longPlay).toHaveAccessibleName(`Play ${long.title}`);
  await expect.poll(async () => (await debug(page))?.status).toBe("stopped");
  await longPlay.click();
  await expect(longPlay).toHaveAccessibleName(`Pause ${long.title}`);

  // The other song's page: the long song plays on in the mini-player; the page shows its song.
  await rows.filter({ hasText: short.title }).getByTestId("song-row-link").click();
  await expect(page.getByTestId("song-title")).toHaveText(short.title);
  const mini = page.getByTestId("mini-player");
  await expect(mini.getByTestId("mini-title")).toHaveText(long.title);
  await expect(mini.getByTestId("mini-play")).toHaveAccessibleName("Pause");
  const overview = page.getByTestId("timeline-overview");
  // Its own length (6 s), not the playing song's (61 s).
  await expect(overview).toHaveAttribute("aria-valuemax", "6", { timeout: 30_000 });
  await expect(page.getByTestId("rehearse-play")).toHaveAccessibleName("Play");
  d = await debug(page);
  expect(d?.songId).toBe(long.songId);
  expect(d?.previewSongId).toBe(short.songId);
  expect(d?.status).toBe("playing");
  const before = d?.position ?? 0;
  await expect.poll(async () => (await debug(page))?.position ?? 0).toBeGreaterThan(before);
  if (isMobile(testInfo)) await noHorizontalOverflow(page);

  // Paused in the mini-player, the long song still keeps the engine: opening the other song's
  // page again shows a preview (owner decision 2026-10-07).
  await page.goBack();
  await expect(rows.first()).toBeVisible();
  await mini.getByTestId("mini-play").click();
  await expect(mini.getByTestId("mini-play")).toHaveAccessibleName("Play");
  await expect.poll(async () => (await debug(page))?.status).toBe("stopped");
  await rows.filter({ hasText: short.title }).getByTestId("song-row-link").click();
  await expect(page.getByTestId("song-title")).toHaveText(short.title);
  await expect(overview).toHaveAttribute("aria-valuemax", "6", { timeout: 30_000 });
  await expect(mini.getByTestId("mini-title")).toHaveText(long.title);
  await expect(mini.getByTestId("mini-play")).toHaveAccessibleName("Play");
  d = await debug(page);
  expect(d?.songId).toBe(long.songId);
  expect(d?.open).toBe(true);
  expect(d?.previewSongId).toBe(short.songId);
  expect(d?.status).toBe("stopped");

  // Play on this page switches the engine to its song and ends the queue.
  await page.getByTestId("rehearse-play").click();
  await expect
    .poll(async () => (await debug(page))?.songId, { timeout: 30_000 })
    .toBe(short.songId);
  await expect.poll(async () => (await debug(page))?.status, { timeout: 30_000 }).toBe("playing");
  d = await debug(page);
  expect(d?.previewSongId).toBeNull();
  expect(d?.queue?.songIds).toEqual([short.songId]);
  await expect(mini).toBeHidden();
  await expect(page.getByTestId("rehearse-play")).toHaveAccessibleName("Pause");
});

test("Project link: a song row plays from there and Play all from the top", async ({
  page,
  browser,
  request,
}, testInfo) => {
  test.setTimeout(600_000);
  await loginAsNewUser(page, request, testInfo, "member");
  const project = `Queue link ${uniqueUsername(testInfo)}`;
  const { items } = await projectWithTwoSongs(page, project);
  const [first, second] = items;
  if (!first || !second) throw new Error("two songs expected");

  await page.getByTestId("project-share").click();
  await page.getByTestId("link-create").click();
  await page.getByTestId("link-form").getByTestId("link-save").click();
  const url = await page.getByTestId("link-created-url").inputValue();
  await page.getByTestId("link-created-close").click();

  const ctx = await browser.newContext({ ...testInfo.project.use, baseURL: undefined });
  const visitor = await ctx.newPage();
  await visitor.goto(url);
  await expect(visitor.getByTestId("link-project-name")).toHaveText(project);
  const rows = visitor.getByTestId("link-song-row");
  await expect(rows).toHaveCount(2);

  // The second song's row plays it; the inline mini-player shows it.
  await rows.filter({ hasText: second.title }).getByTestId("link-song-play").click();
  await expect
    .poll(async () => (await debug(visitor))?.songId, { timeout: 30_000 })
    .toBe(second.songId);
  await expect
    .poll(async () => (await debug(visitor))?.status, { timeout: 30_000 })
    .toBe("playing");
  const mini = visitor.getByTestId("mini-player");
  await expect(mini.getByTestId("mini-title")).toHaveText(second.title);
  if (isMobile(testInfo)) await noHorizontalOverflow(visitor);

  // "Play all" starts from the first song.
  await visitor.getByTestId("play-all").click();
  await expect
    .poll(async () => (await debug(visitor))?.songId, { timeout: 30_000 })
    .toBe(first.songId);
  await expect
    .poll(async () => (await debug(visitor))?.status, { timeout: 30_000 })
    .toBe("playing");
  await expect(mini.getByTestId("mini-title")).toHaveText(first.title);

  // Opening the playing song keeps it playing.
  await mini.getByTestId("mini-open").click();
  await expect(visitor.getByTestId("link-song-title")).toHaveText(first.title);
  await expect(visitor.getByTestId("rehearse-play")).toHaveAccessibleName("Pause", {
    timeout: 30_000,
  });
  await ctx.close();
});
