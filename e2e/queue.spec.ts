import path from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { FIXTURES_DIR, generateFixtures } from "@bandroom/fixtures";
import { isMobile, loginAsNewUser, uniqueUsername } from "./helpers";

/**
 * The engine queue and the mini-player (SPEC §6.10, §27.4): "Play all" moves on to the next song
 * at the end, the song keeps playing across in-app navigation, the song page reattaches without a
 * reload, deleting the playing song stops it, and a project link's song rows and "Play all" use
 * the same queue.
 */

test.beforeAll(async () => {
  await generateFixtures();
});

// Two 6 s files: the queue reaches the second song quickly.
const FILES = ["imp_48000_s16_stereo", "imp_44100_s16_stereo"];

interface DebugState {
  songId: string | null;
  open: boolean;
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

/** A project with two short songs from a folder drop, both processed; returns the queue order. */
async function projectWithTwoSongs(page: Page, name: string) {
  await page.goto("library");
  await page.getByTestId("new-project").click();
  await page.getByLabel("Name").fill(name);
  await page.getByTestId("create-project-submit").click();
  await page.getByTestId("project-settings-tab").waitFor();
  const projectId = /projects\/([^/?#]+)/.exec(page.url())?.[1] ?? "";
  await page
    .getByTestId("folder-dropzone")
    .locator('input[type="file"]')
    .setInputFiles(FILES.map((f) => path.join(FIXTURES_DIR, `${f}.wav`)));
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

  // Back on the first song's page: it opens in the engine (another song opens: the queue moves).
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
