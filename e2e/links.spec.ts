import { expect, test, type Page } from "@playwright/test";
import { generateFixtures, TONE_FILE } from "@bandroom/fixtures";
import { isMobile, loginAsNewUser, uniqueUsername } from "./helpers";

test.beforeAll(async () => {
  await generateFixtures();
});

interface DebugState {
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

async function noHorizontalOverflow(page: Page) {
  await expect
    .poll(() => page.evaluate(() => window.innerWidth === document.documentElement.clientWidth))
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(0);
}

/** A new project with one song and one processed track; returns the song page path. */
async function songWithTrack(page: Page, project: string, title: string) {
  await page.goto("library");
  await page.getByTestId("new-project").click();
  await page.getByLabel("Name").fill(project);
  await page.getByTestId("create-project-submit").click();
  await page.getByTestId("project-settings-tab").waitFor();
  await page.getByTestId("new-song").click();
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page.getByTestId("create-song-submit").click();
  await page.getByTestId("song-row").filter({ hasText: title }).getByRole("link").click();
  await page.getByTestId("track-dropzone").locator('input[type="file"]').setInputFiles(TONE_FILE());
  const rows = page.getByTestId("track-row");
  await expect(rows).toHaveCount(1, { timeout: 20_000 });
  // One worker serves all parallel tests on this server.
  await expect(rows.filter({ hasText: "kHz" })).toHaveCount(1, { timeout: 240_000 });
}

test("Public links: a password link plays and takes anonymous comments until it is revoked", async ({
  page,
  browser,
  request,
}, testInfo) => {
  test.setTimeout(420_000);
  const phone = isMobile(testInfo);
  await loginAsNewUser(page, request, testInfo, "member");
  await songWithTrack(page, `Links ${uniqueUsername(testInfo)}`, "Share me");

  // The project manager creates a password-protected all-tracks link with comments.
  const section = page.getByTestId("song-links");
  await section.scrollIntoViewIfNeeded();
  await section.getByTestId("link-create").click();
  const form = page.getByTestId("link-form");
  await form.getByTestId("link-label").fill("For mastering");
  await form.getByTestId("link-content").getByText("All tracks", { exact: true }).click();
  await form.getByTestId("link-password-switch").click();
  await form.getByTestId("link-password").fill("open sesame");
  await form.getByTestId("link-allow-comments").click();
  await form.getByTestId("link-save").click();
  const urlInput = page.getByTestId("link-created-url");
  await expect(urlInput).toBeVisible();
  const url = await urlInput.inputValue();
  // Absolute URL with the runtime base path.
  const base = new URL(testInfo.project.use.baseURL ?? "").pathname.replace(/\/$/, "");
  expect(new URL(url).pathname).toMatch(new RegExp(`^${base}/l/[A-Za-z0-9_-]{22}$`));
  await page.getByTestId("link-created-close").click();
  const card = section.getByTestId("link-card");
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId("link-card-label")).toHaveText("For mastering");

  // An unauthenticated visitor in a fresh browser context.
  const visitorCtx = await browser.newContext({ ...testInfo.project.use, baseURL: undefined });
  const visitor = await visitorCtx.newPage();
  await visitor.goto(url);
  await expect(visitor.getByTestId("link-password-prompt")).toBeVisible();
  // Nothing about the content before the password.
  await expect(visitor.getByTestId("link-project-name")).toHaveCount(0);
  await visitor.getByTestId("link-password-input").fill("wrong");
  await visitor.getByTestId("link-unlock").click();
  await expect(visitor.getByTestId("link-password-error")).toBeVisible();
  await visitor.getByTestId("link-password-input").fill("open sesame");
  await visitor.getByTestId("link-unlock").click();
  await expect(visitor.getByTestId("link-song-title")).toHaveText("Share me");

  // All-tracks links open with the Mixer; play it.
  await expect(visitor.getByTestId("rehearse-panel")).toBeVisible({ timeout: 30_000 });
  await expect(visitor.getByTestId("mixer-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(async () => (await debug(visitor))?.status, { timeout: 60_000 })
    .toBe("stopped");
  await visitor.getByTestId("rehearse-play").click();
  await expect
    .poll(async () => (await debug(visitor))?.status, { timeout: 60_000 })
    .toBe("playing");
  const p1 = (await debug(visitor))?.position ?? 0;
  await expect.poll(async () => (await debug(visitor))?.position ?? 0).toBeGreaterThan(p1 + 12_000);
  await visitor.getByTestId("rehearse-play").click();
  // Band-only tools are not there.
  await expect(visitor.getByTestId("mixer-save-defaults")).toHaveCount(0);
  if (phone) await noHorizontalOverflow(visitor);

  // An anonymous comment at the playhead, under a display name.
  await visitor.getByTestId("comment-at-playhead").click();
  const panel = visitor.getByTestId("comments-panel");
  await panel.getByTestId("visitor-name").fill("Mastering Mike");
  await panel.getByTestId("comment-input").fill("The low end is a bit boomy here");
  await panel.getByTestId("comment-input-submit").click();
  const item = panel.getByTestId("comment-item");
  await expect(item).toHaveCount(1);
  await expect(item).toContainText("Mastering Mike");
  await expect(item).toContainText("The low end is a bit boomy here");
  await expect(item.getByTestId("comment-react")).toHaveCount(0);
  await panel.getByTestId("comments-close").click();

  // The band sees the comment (marked as coming through a link) and the link's analytics.
  await page.reload();
  await page.getByTestId("open-comments").click();
  const bandItem = page.getByTestId("comments-panel").getByTestId("comment-item");
  await expect(bandItem.filter({ hasText: "Mastering Mike" })).toHaveCount(1);
  await expect(bandItem.getByTestId("comment-via-link")).toHaveCount(1);
  await page.getByTestId("comments-close").click();
  const card2 = page.getByTestId("song-links").getByTestId("link-card");
  await expect(card2.getByTestId("link-card-stats")).toContainText("1 open");
  await card2.getByTestId("link-menu").click();
  await page.getByTestId("link-analytics").click();
  const stats = page.getByTestId("link-analytics-modal");
  await expect(stats.getByTestId("link-stat-plays")).toContainText("1");
  await expect(stats.getByTestId("link-stat-comments")).toContainText("1");
  await expect(stats.getByTestId("link-stat-passwordFailures")).toContainText("1");
  await expect(stats.getByTestId("link-activity")).toContainText("Mastering Mike");
  await page.keyboard.press("Escape");

  // Revoking locks the visitor out at once.
  await card2.getByTestId("link-menu").click();
  await page.getByTestId("link-revoke").click();
  await page.getByTestId("link-revoke-confirm").click();
  await expect(card2.getByText("Revoked")).toBeVisible();
  const api = await visitor.request.get(url.replace("/l/", "/api/v1/l/") + "/songs/x/tracks");
  expect(api.status()).toBe(404);
  await visitor.reload();
  await expect(visitor.getByTestId("link-unavailable")).toBeVisible();
  await visitorCtx.close();
});

test("Public links: a project link lists the songs without a password", async ({
  page,
  browser,
  request,
}, testInfo) => {
  test.setTimeout(420_000);
  await loginAsNewUser(page, request, testInfo, "member");
  const project = `Album ${uniqueUsername(testInfo)}`;
  await songWithTrack(page, project, "Opener");

  await page.getByRole("link", { name: project }).first().click();
  await page.getByTestId("project-share").click();
  await page.getByTestId("link-create").click();
  const form = page.getByTestId("link-form");
  await form.getByTestId("link-label").fill("Press kit");
  await form.getByTestId("link-save").click();
  const url = await page.getByTestId("link-created-url").inputValue();
  await page.getByTestId("link-created-close").click();

  const visitorCtx = await browser.newContext({ ...testInfo.project.use, baseURL: undefined });
  const visitor = await visitorCtx.newPage();
  await visitor.goto(url);
  await expect(visitor.getByTestId("link-project-name")).toHaveText(project);
  await expect(visitor.getByTestId("link-song-row")).toHaveCount(1);
  await visitor.getByTestId("link-song-open").click();
  await expect(visitor.getByTestId("link-song-title")).toHaveText("Opener");
  // Mix-only links play the mix, with no Mixer; without comments allowed there are no comment
  // tools.
  await expect(
    visitor.getByTestId("listen-panel").or(visitor.getByTestId("link-mix-preparing")),
  ).toBeVisible({ timeout: 30_000 });
  await expect(visitor.getByTestId("mixer-toggle")).toHaveCount(0);
  await expect(visitor.getByTestId("comment-toolbar")).toHaveCount(0);
  if (isMobile(testInfo)) await noHorizontalOverflow(visitor);

  // Deactivating also locks the visitor out; reactivating lets them back in.
  const card = page.getByTestId("links-panel").getByTestId("link-card");
  await card.getByTestId("link-menu").click();
  await page.getByTestId("link-toggle-active").click();
  await expect(card.getByText("Inactive")).toBeVisible();
  await visitor.reload();
  await expect(visitor.getByTestId("link-unavailable")).toBeVisible();
  await card.getByTestId("link-menu").click();
  await page.getByTestId("link-toggle-active").click();
  await expect(card.getByText("Active", { exact: true })).toBeVisible();
  await visitor.reload();
  await expect(visitor.getByTestId("link-song-title")).toHaveText("Opener");
  await visitorCtx.close();
});
