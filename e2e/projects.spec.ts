import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { FIXTURES_DIR, generateFixtures } from "@bandroom/fixtures";
import {
  apiLogin,
  createUser,
  isMobile,
  loginAsNewUser,
  uniqueUsername,
  USER_PASSWORD,
} from "./helpers";

test("create a project and songs, reorder, and share one song with a guest", async ({
  page,
  request,
  browser,
  baseURL,
}, testInfo) => {
  // Long flow (two browser contexts, several saves): 30 s is tight on a loaded machine.
  test.setTimeout(60_000);
  test.skip(
    !["chromium", "iphone", "subpath-chromium"].includes(testInfo.project.name),
    "full flow on selected projects",
  );
  // A member creates the project and becomes its manager.
  await loginAsNewUser(page, request, testInfo, "member");
  const guest = uniqueUsername(testInfo, "g");
  await createUser(request, guest, "guest");

  await page.goto("library");
  await page.getByTestId("new-project").click();
  const projectName = `Album ${guest}`;
  await page.getByLabel("Name").fill(projectName);
  await page.getByRole("radio", { name: "Teal" }).click();
  await page.getByTestId("create-project-submit").click();
  await expect(page.getByRole("heading", { level: 2, name: projectName })).toBeVisible();

  for (const title of ["Intro", "Ballad", "Closer"]) {
    await page.getByTestId("new-song").click();
    await page.getByLabel("Title", { exact: true }).fill(title);
    await page.getByTestId("create-song-submit").click();
    await expect(page.getByTestId("song-row").filter({ hasText: title })).toBeVisible();
  }
  const titles = () =>
    page.getByTestId("song-row").locator("p.mantine-Text-root[data-truncate]").allInnerTexts();
  await expect.poll(titles).toEqual(["Intro", "Ballad", "Closer"]);

  if (!isMobile(testInfo)) {
    // Keyboard reordering (dnd-kit): pick up "Closer", move it up twice, drop.
    const handle = page.getByRole("button", { name: "Move Closer" });
    // dnd-kit's live region names the song id the dragged song is over after each step.
    const songId = async (title: string) =>
      (
        (await page
          .getByTestId("song-row")
          .filter({ hasText: title })
          .getByRole("link")
          .getAttribute("href")) ?? ""
      )
        .split("/")
        .pop() ?? "";
    const [closer, ballad, intro] = [
      await songId("Closer"),
      await songId("Ballad"),
      await songId("Intro"),
    ];
    const live = page.locator('[id^="DndLiveRegion"]');
    await handle.focus();
    await page.keyboard.press("Space");
    await expect(live).toContainText(`over droppable area ${closer}.`);
    // A step pressed while dnd-kit is still measuring the list is ignored (the song stays over
    // its own place), so a step is repeated until the announcement names the next song.
    for (const target of [ballad, intro]) {
      await expect(async () => {
        if ((await live.textContent())?.includes(`over droppable area ${target}.`)) return;
        await page.keyboard.press("ArrowUp");
        await expect(live).toContainText(`over droppable area ${target}.`, { timeout: 1_000 });
      }).toPass({ timeout: 15_000 });
    }
    await page.keyboard.press("Space");
    await expect(live).toContainText(/dropped/i);
    await expect.poll(titles).toEqual(["Closer", "Intro", "Ballad"]);
    await page.reload();
    await expect.poll(titles).toEqual(["Closer", "Intro", "Ballad"]);
  }

  // Share "Ballad" with the guest as a commenter.
  await page.getByTestId("song-row").filter({ hasText: "Ballad" }).getByRole("link").click();
  await expect(page.getByRole("heading", { level: 2, name: "Ballad" })).toBeVisible();
  const row = page.locator(`[data-testid="grant-row"][data-username="${guest}"]`);
  await row.getByTestId("grant-select").click();
  await page.getByRole("option", { name: "Commenter" }).click();
  await expect(row.getByTestId("grant-select")).toHaveValue("Commenter");

  // The guest sees only this project, in reduced view, with only that song.
  const guestCtx = await browser.newContext({ ...testInfo.project.use, baseURL });
  const guestPage = await guestCtx.newPage();
  await apiLogin(guestPage.request, guest, USER_PASSWORD);
  await guestPage.goto("library");
  const cards = guestPage.getByTestId("project-card");
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText(projectName);
  await expect(cards.first()).toContainText("1 song");
  await expect(cards.first()).toContainText("selected songs");
  await cards.first().click();
  await expect(
    guestPage.getByText("You can see only the songs that were shared with you."),
  ).toBeVisible();
  await expect(guestPage.getByTestId("song-row")).toHaveCount(1);
  await expect(guestPage.getByTestId("song-row")).toContainText("Ballad");
  await expect(guestPage.getByTestId("new-song")).toHaveCount(0);
  await expect(guestPage.getByTestId("project-settings-tab")).toHaveCount(0);
  await guestCtx.close();
});

test("a member cannot see the admin settings, admins can change default roles", async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "desktop only");
  await loginAsNewUser(page, request, testInfo, "admin");
  await page.goto("admin?tab=settings");
  await expect(page.getByTestId("default-role-member")).toHaveValue("Contributor");
});

test("deleting a project requires typing its name", async ({ page, request }, testInfo) => {
  test.skip(!["chromium", "iphone"].includes(testInfo.project.name), "selected projects");
  await loginAsNewUser(page, request, testInfo, "member");
  await page.goto("library");
  await page.getByTestId("new-project").click();
  const name = `Trash ${uniqueUsername(testInfo)}`;
  await page.getByLabel("Name").fill(name);
  await page.getByTestId("create-project-submit").click();
  await page.getByTestId("project-settings-tab").click();
  await page.getByTestId("delete-project").click();
  await expect(page.getByTestId("confirm-delete")).toBeDisabled();
  await page.getByTestId("confirm-name").fill(name);
  await page.getByTestId("confirm-delete").click();
  await expect(page).toHaveURL(/\/library$/);
  await expect(page.getByTestId("project-card").filter({ hasText: name })).toHaveCount(0);
});

test("song rows show the length, mono/stereo and size, also at 360 px", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  test.skip(
    !["chromium", "iphone", "pixel"].includes(testInfo.project.name),
    "row layout on desktop and phones",
  );
  await generateFixtures();
  await loginAsNewUser(page, request, testInfo, "member");
  const csrf = { "X-Requested-With": "bandroom" };
  const p = await page.request.post("api/v1/projects", {
    headers: csrf,
    data: { name: `Stats ${uniqueUsername(testInfo)}` },
  });
  const { project } = (await p.json()) as { project: { id: string } };
  const songOf = async (title: string) => {
    const s = await page.request.post(`api/v1/projects/${project.id}/songs`, {
      headers: csrf,
      data: { title },
    });
    return ((await s.json()) as { song: { id: string } }).song.id;
  };
  const songId = await songOf("A song with a rather long title that has to truncate on phones");
  await songOf("Empty");

  // One stereo and one mono track, 6 s each.
  await page.goto(`songs/${songId}`);
  const files = await Promise.all(
    ["stereo", "mono"].map(async (layout) => ({
      name: `${layout}.wav`,
      mimeType: "audio/wav",
      buffer: await fs.readFile(path.join(FIXTURES_DIR, `imp_48000_s16_${layout}.wav`)),
    })),
  );
  await page.getByTestId("track-dropzone").locator('input[type="file"]').setInputFiles(files);
  await expect(page.getByTestId("track-row")).toHaveCount(2, { timeout: 60_000 });
  await expect(page.getByTestId("track-processing")).toHaveCount(0, { timeout: 120_000 });

  for (const width of [null, 360]) {
    if (width) await page.setViewportSize({ width, height: 740 });
    await page.goto(`projects/${project.id}`);
    const row = page.getByTestId("song-row").filter({ hasText: "rather long title" });
    await expect(row.getByTestId("song-length")).toHaveText("0:06", { timeout: 30_000 });
    const mark = row.getByTestId("song-channels");
    await expect(mark).toHaveAttribute("data-channels", "stereo");
    await expect(mark).toHaveAccessibleName("2 tracks: 1 stereo, 1 mono");
    // The size: on the right when there is room, else under the title.
    await expect(row.getByText(/\d+(\.\d+)?\s?[kKM]B/)).toBeVisible();
    // A song without audio has no length or mark.
    const empty = page.getByTestId("song-row").filter({ hasText: "Empty" });
    await expect(empty).toBeVisible();
    await expect(empty.getByTestId("song-row-stats")).toHaveCount(0);
    // The meta stays on one line, inside the row, and the title keeps its room.
    const box = await row.boundingBox();
    const stats = await row.getByTestId("song-row-stats").boundingBox();
    const title = await row.getByText("rather long title").boundingBox();
    expect(box && stats && title).toBeTruthy();
    if (box && stats && title) {
      expect(stats.x + stats.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
      expect(stats.height).toBeLessThan(24);
      expect(title.width).toBeGreaterThan(80);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(0);
  }
});
