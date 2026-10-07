import { expect, test } from "@playwright/test";
import { generateFixtures } from "@bandroom/fixtures";
import { loginAsNewUser } from "./helpers";
import { SAMPLY_MOCK_KEY } from "./samply-mock.mjs";

test.beforeAll(async () => {
  await generateFixtures();
});

test("Samply import: connect, scan, review, dry run, import, report", async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    !["chromium", "subpath-chromium"].includes(testInfo.project.name),
    "one run per server (the import creates shared data)",
  );
  test.setTimeout(120_000);
  await loginAsNewUser(page, request, testInfo, "admin");

  await page.goto("admin?tab=import");
  await page.getByTestId("import-new").click();
  await page.getByTestId("samply-key").fill("not-the-right-key");
  await page.getByTestId("samply-connect").click();
  await expect(page.getByText("Samply rejected this API key")).toBeVisible();

  await page.getByTestId("samply-key").fill(SAMPLY_MOCK_KEY);
  await page.getByTestId("samply-connect").click();
  const project = page.getByRole("checkbox", { name: "Mock Album" });
  await expect(project).toBeVisible();
  await project.check();
  await page.getByTestId("import-scan").click();

  // Review: nothing is grouped automatically; the folder is a folder of songs.
  const node = (name: string) =>
    page.locator(`[data-testid="import-node"][data-node-name="${name}"]`);
  await expect(node("Stems Tune")).toBeVisible({ timeout: 30_000 });
  await expect(node("Stems Tune").getByTestId("import-node-action")).toHaveValue("Folder of songs");
  const totals = page.getByTestId("import-totals");
  await expect(totals).toContainText("Songs3");
  await expect(page.getByTestId("artwork-unavailable")).toContainText(/picture can.t be imported/);

  // Tick the two equal-length stems and make them one multitrack song.
  await node("Stems Tune - Bass").getByTestId("import-node-select").check();
  await node("Stems Tune - Drums").getByTestId("import-node-select").check();
  await expect(page.getByTestId("group-title")).toHaveValue("Stems Tune");
  await page.getByTestId("group-make").click();
  await expect(node("Stems Tune - Drums").getByTestId("import-node-action")).toHaveValue(
    "Track of another song",
  );
  await expect(totals).toContainText("Songs2");
  await expect(totals).toContainText("Tracks3");
  await node("lyrics").getByTestId("import-node-attach").click();
  await page.getByRole("option", { name: "Stems Tune" }).click();

  await page.getByTestId("import-dry-run").click();
  await expect(page.getByTestId("dry-run-summary")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("dry-run-summary")).toContainText("Songs 2");

  await page.getByTestId("import-start").click();
  const report = page.getByTestId("import-report");
  await expect(report).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("import-status")).toHaveText("Finished");
  await expect(report.getByTestId("report-row-version")).toContainText("Versions3");
  await expect(report.getByTestId("report-row-comment")).toContainText("Comments1");
  await expect(report).toContainText("Samply Friend");

  // The imported project shows up in the library with its songs.
  await page.getByTestId("desktop-nav").getByRole("link", { name: "Library" }).click();
  await page
    .getByRole("link", { name: /Mock Album/ })
    .first()
    .click();
  await expect(page.getByTestId("song-row").filter({ hasText: "Demo Song" })).toBeVisible();
  await expect(page.getByTestId("song-row").filter({ hasText: "Stems Tune" })).toBeVisible();
});
