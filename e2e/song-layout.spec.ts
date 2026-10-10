import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { generateFixtures, TONE_FILE } from "@bandroom/fixtures";
import {
  ADMIN,
  apiLogin,
  createUser,
  isMobile,
  loginAsNewUser,
  uniqueUsername,
  USER_PASSWORD,
} from "./helpers";

/**
 * M25 song page layout (SPEC §31.7): the two-row sticky control bar and its row heights, the
 * section pills (off by default, per user), the meter rule, and on a phone in landscape the
 * hidden app chrome, the one-row bar and 150 px track headers. Runs on chromium, the phone
 * projects and iphone-landscape.
 */

test.beforeAll(async () => {
  await generateFixtures();
});

const CSRF = { "X-Requested-With": "bandroom" };
const m = (num: number, den: number) => ({ num, den });

const landscape = (testInfo: TestInfo) => testInfo.project.name === "iphone-landscape";

async function newSong(page: Page, projectId: string, title: string, meters: number[][]) {
  const res = await page.request.post(`api/v1/projects/${projectId}/songs`, {
    headers: CSRF,
    data: { title },
  });
  const { song } = (await res.json()) as { song: { id: string } };
  const segments = meters.map(([num = 4, den = 4], i) => ({
    startBeat: i * 8,
    bpm: 120,
    meter: m(num, den),
    barIndex: i * 2,
  }));
  const tempo = await page.request.put(`api/v1/songs/${song.id}/tempo`, {
    headers: CSRF,
    data: { bar1OffsetSec: 0, map: { segments } },
  });
  expect(tempo.ok()).toBe(true);
  return song.id;
}

const noOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test("Song layout: sticky two-row bar, section pills, meter rule (SPEC §31)", async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const phone = isMobile(testInfo) && !landscape(testInfo);
  const coarse = isMobile(testInfo);
  if (phone) await page.setViewportSize({ width: 360, height: 780 });
  await loginAsNewUser(page, page.request, testInfo, "member");
  const res = await page.request.post("api/v1/projects", {
    headers: CSRF,
    data: { name: `Layout ${uniqueUsername(testInfo)}` },
  });
  const { project } = (await res.json()) as { project: { id: string } };
  const songId = await newSong(page, project.id, "Odd meters", [
    [4, 4],
    [7, 8],
  ]);
  for (const [name, startSec, endSec] of [
    ["Verse", 0, 2],
    ["Chorus", 2, 4],
    ["Outro", 4, 6],
  ] as const) {
    await page.request.post(`api/v1/songs/${songId}/markers`, {
      headers: CSRF,
      data: { type: "section", name, color: "blue", startSec, endSec },
    });
  }
  await page.goto(`songs/${songId}`);
  await page.getByTestId("track-dropzone").locator('input[type="file"]').setInputFiles(TONE_FILE());
  await expect(page.getByTestId("track-row").filter({ hasText: "kHz" })).toHaveCount(1, {
    timeout: 180_000,
  });
  await expect(page.getByTestId("rehearse-play")).toBeEnabled({ timeout: 60_000 });

  const bar = page.getByTestId("rehearse-transport");
  const row1 = bar.getByTestId("transport-row");
  await expect(bar).toHaveAttribute(
    "data-layout",
    landscape(testInfo) ? "landscape" : phone ? "phone" : "desktop",
  );

  // Row heights (SPEC §31.1): row 2 is 32 px with a mouse, 44 px on touch; landscape is one
  // 48 px row.
  if (landscape(testInfo)) {
    await expect(bar.getByTestId("context-row")).toHaveCount(0);
    expect((await row1.boundingBox())?.height).toBeCloseTo(48, 0);
  } else {
    const row2 = bar.getByTestId("context-row");
    const h = (await row2.boundingBox())?.height ?? 0;
    if (coarse) expect(h).toBeCloseTo(44, 0);
    else expect(Math.round(h)).toBe(32);
  }

  // The meter rule (SPEC §31.5): the song changes meter, so the transport shows it; phones and
  // landscape show bar.beat in row 1.
  await expect(bar.getByTestId("meter-readout")).toHaveText("4/4");
  await expect(row1.getByTestId("bar-beat")).toHaveText("1.1");
  // On the ruler: the change, boxed; no Markers or Signature lane.
  await expect(page.getByTestId("signature-item")).toHaveText(["7/8"]);
  await expect(page.getByTestId("lane-label-signature")).toHaveCount(0);
  await expect(page.getByTestId("lane-label-markers")).toHaveCount(0);

  // Section pills: off by default; the Sections toggle shows them, the choice survives a reload.
  await expect(page.getByTestId("section-chip")).toHaveCount(0);
  const toggle = page.getByTestId("section-pills-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  const pills = page.getByTestId("section-chip");
  await expect(pills).toHaveText(["Verse", "Chorus", "Outro"]);
  const pillH = (await pills.first().boundingBox())?.height ?? 0;
  expect(Math.round(pillH)).toBe(coarse ? 34 : 22);
  // Double tap loops the section.
  await pills.nth(1).dblclick();
  await expect(pills.nth(1)).toHaveAttribute("data-looped", "true");
  await page.reload();
  await expect(page.getByTestId("section-chip")).toHaveCount(3, { timeout: 30_000 });

  // Both rows stay pinned while the page scrolls within the Player (SPEC §31.1): the bar stays
  // under the app header while the timeline moves up beneath it.
  const header = await page.getByTestId("app-header").boundingBox();
  const pinnedAt = landscape(testInfo) ? 0 : Math.round((header?.y ?? 0) + (header?.height ?? 0));
  const barTop = (await bar.boundingBox())?.y ?? 0;
  await page.evaluate(
    (by) => {
      window.scrollBy(0, by);
    },
    barTop - pinnedAt + 150,
  );
  await expect
    .poll(async () => Math.round((await bar.boundingBox())?.y ?? -1), { timeout: 5_000 })
    .toBe(pinnedAt);
  const below = await page.getByTestId("timeline").boundingBox();
  expect(below?.y ?? 0).toBeLessThan(pinnedAt + ((await bar.boundingBox())?.height ?? 0));
  expect(await noOverflow(page)).toBeLessThanOrEqual(0);
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });

  // Phones: the section name in the transport toggles the pills too.
  if (coarse) {
    await page.getByTestId("transport-readout").click();
    await expect(page.getByTestId("section-chip")).toHaveCount(0);
    await page.getByTestId("transport-readout").click();
    await expect(page.getByTestId("section-chip")).toHaveCount(3);
  }

  // Landscape (SPEC §31.6): no app header or tab bar, the compact title, 150 px track headers.
  if (landscape(testInfo)) {
    await expect(page.getByTestId("app-header")).not.toBeInViewport();
    await expect(page.getByTestId("chrome-show")).toHaveCount(0);
    await expect(page.getByTestId("song-title-compact")).toHaveText("Odd meters");
    await page.getByTestId("transport-more").click();
    const mixer = page.getByTestId("mixer-toggle");
    if ((await mixer.getAttribute("aria-checked")) !== "true") await mixer.click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("track-strip").first()).toBeVisible({ timeout: 30_000 });
    expect(Math.round((await page.getByTestId("track-headers").boundingBox())?.width ?? 0)).toBe(
      150,
    );
    expect(await noOverflow(page)).toBeLessThanOrEqual(0);
    // Another page shows the chrome again.
    await page.getByTestId("song-back").click();
    await expect(page.getByTestId("app-header")).toBeInViewport();
  }

  // The pills are this user's choice: another user on the device starts with them off.
  const other = uniqueUsername(testInfo, "o");
  await createUser(page.request, other, "member");
  await apiLogin(page.request, other, USER_PASSWORD);
  const session = (await (await page.request.get("api/v1/auth/session")).json()) as {
    user: { id: string };
  };
  await apiLogin(page.request, ADMIN.username, ADMIN.password);
  const grant = await page.request.put(`api/v1/projects/${project.id}/grants/${session.user.id}`, {
    headers: CSRF,
    data: { role: "viewer" },
  });
  expect(grant.ok()).toBe(true);
  await apiLogin(page.request, other, USER_PASSWORD);
  await page.goto(`songs/${songId}`);
  await expect(page.getByTestId("rehearse-transport")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("section-pills-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("section-chip")).toHaveCount(0);
});

test("Song layout: no meter in the transport when the song keeps one meter", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await loginAsNewUser(page, page.request, testInfo, "member");
  const res = await page.request.post("api/v1/projects", {
    headers: CSRF,
    data: { name: `Meter ${uniqueUsername(testInfo)}` },
  });
  const { project } = (await res.json()) as { project: { id: string } };
  const songId = await newSong(page, project.id, "Four four", [[4, 4]]);
  await page.goto(`songs/${songId}`);
  const bar = page.getByTestId("rehearse-transport");
  await expect(bar.getByTestId("bar-beat")).toHaveText("1.1", { timeout: 30_000 });
  await expect(bar.getByTestId("meter-readout")).toHaveCount(0);
  await expect(page.getByTestId("signature-item")).toHaveCount(0);
  await expect(page.getByTestId("song-tempo")).toContainText("4/4");
});
