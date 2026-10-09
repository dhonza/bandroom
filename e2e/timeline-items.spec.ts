import { expect, test } from "@playwright/test";
import { generateFixtures, TONE_FILE } from "@bandroom/fixtures";
import { isMobile, loginAsNewUser, uniqueUsername } from "./helpers";

test.beforeAll(async () => {
  await generateFixtures();
});

const api = { headers: { "X-Requested-With": "bandroom" } };

test("Timeline items: rename, convert markers to sections and back, move a comment", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const phone = isMobile(testInfo);
  await loginAsNewUser(page, page.request, testInfo, "member");

  const projectRes = await page.request.post("api/v1/projects", {
    ...api,
    data: { name: `Items ${uniqueUsername(testInfo)}` },
  });
  expect(projectRes.ok()).toBe(true);
  const { project } = (await projectRes.json()) as { project: { id: string } };
  const songRes = await page.request.post(`api/v1/projects/${project.id}/songs`, {
    ...api,
    data: { title: "Items" },
  });
  const { song } = (await songRes.json()) as { song: { id: string } };
  for (const [name, startSec] of [
    ["Intro", 1],
    ["Verse", 4],
    ["Outro", 7],
  ] as const) {
    const res = await page.request.post(`api/v1/songs/${song.id}/markers`, {
      ...api,
      data: { type: "marker", name, color: "yellow", startSec },
    });
    expect(res.ok()).toBe(true);
  }
  const comment = await page.request.post(`api/v1/songs/${song.id}/comments`, {
    ...api,
    data: { body: "Too loud here", startSec: 2 },
  });
  expect(comment.ok()).toBe(true);

  await page.goto(`songs/${song.id}`);
  await page.getByTestId("track-dropzone").locator('input[type="file"]').setInputFiles(TONE_FILE());
  await expect(page.getByTestId("track-row").filter({ hasText: "kHz" })).toHaveCount(1, {
    timeout: 180_000,
  });

  await page.getByRole("button", { name: "Playback options" }).first().click();
  await page.getByTestId("transport-timeline-items").click();
  const dialog = page.getByTestId("timeline-items");
  const rows = dialog.getByTestId("items-row");
  await expect(rows).toHaveCount(3);
  await page.screenshot({ path: testInfo.outputPath("items-markers.png") });

  // Rename on blur.
  const name = rows.first().getByTestId("items-name");
  await name.fill("Intro A");
  await name.press("Enter");
  await expect(page.getByTestId("marker-item").filter({ hasText: "Intro A" })).toHaveCount(1);

  // All three markers become sections; the last one ends at the song end.
  await dialog.getByTestId("items-select-all").click();
  await dialog.getByTestId("items-to-sections").click();
  await expect(page.getByTestId("section-item")).toHaveCount(3);
  await expect(page.getByTestId("marker-item")).toHaveCount(0);

  // And back.
  await dialog.getByTestId("items-select-all").click();
  await dialog.getByTestId("items-to-markers").click();
  await expect(page.getByTestId("marker-item")).toHaveCount(3);
  await expect(page.getByTestId("section-item")).toHaveCount(0);

  // Move the comment to 5 s.
  await dialog.getByTestId("items-tab-comments").click();
  const commentRow = dialog.getByTestId("items-comment-row");
  await expect(commentRow).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("items-comments.png") });
  const start = commentRow.getByRole("textbox").first();
  await start.fill("0:05");
  await start.press("Enter");
  await expect
    .poll(async () => {
      const res = await page.request.get(`api/v1/songs/${song.id}/comments`, api);
      const body = (await res.json()) as { comments: { startSec: number | null }[] };
      return body.comments[0]?.startSec;
    })
    .toBe(5);
  if (phone)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      page.viewportSize()?.width ?? 0,
    );
});
