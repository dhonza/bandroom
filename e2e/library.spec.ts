import { expect, test, type Page } from "@playwright/test";
import { loginAsNewUser } from "./helpers";

const CSRF = { "X-Requested-With": "bandroom" };

async function createProject(page: Page, name: string): Promise<void> {
  const res = await page.request.post("api/v1/projects", { headers: CSRF, data: { name } });
  expect(res.ok()).toBe(true);
}

/** Names of the shown projects, top to bottom (grid or list). */
const shownNames = (page: Page) => page.getByTestId("project-name").allTextContents();

test("library: sort menu, stars pinned first, grid/list toggle and filters", async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    !["chromium", "iphone", "subpath-chromium"].includes(testInfo.project.name),
    "selected projects",
  );
  const user = await loginAsNewUser(page, request, testInfo, "member");
  // Other tests share the server: the search narrows the Library to this test's projects.
  const tag = `lib-${user}`;
  for (const n of ["Bravo", "Alpha", "Charlie"]) await createProject(page, `${tag} ${n}`);

  await page.goto("library");
  await page.getByLabel("Search projects").fill(tag);
  await expect(page.getByTestId("project-grid")).toBeVisible();
  await expect(page.getByTestId("project-card")).toHaveCount(3);
  await expect(page.getByTestId("project-creator").first()).toHaveText(`E2E ${user}`);

  // Sort menu: key and order, with checkmarks; it stays open between choices.
  await page.getByTestId("library-sort").click();
  await page.getByTestId("sort-name").click();
  await page.getByTestId("order-asc").click();
  await expect(page.getByTestId("sort-name")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("order-asc")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect
    .poll(() => shownNames(page))
    .toEqual(["Alpha", "Bravo", "Charlie"].map((n) => `${tag} ${n}`));

  // A star pins the project first; the sort still applies to the rest.
  const charlie = page.getByTestId("project-card").filter({ hasText: `${tag} Charlie` });
  await charlie.getByTestId("project-star").click();
  await expect(charlie.getByTestId("project-star")).toHaveAttribute("data-starred", "true");
  await expect
    .poll(() => shownNames(page))
    .toEqual(["Charlie", "Alpha", "Bravo"].map((n) => `${tag} ${n}`));

  await page.getByTestId("library-sort").click();
  await page.getByTestId("order-desc").click();
  await page.keyboard.press("Escape");
  await expect
    .poll(() => shownNames(page))
    .toEqual(["Charlie", "Bravo", "Alpha"].map((n) => `${tag} ${n}`));

  // List view, remembered on this device; the star is kept on the server.
  await page.getByTestId("library-view-list").click();
  await expect(page.getByTestId("project-list")).toBeVisible();
  await expect(page.getByTestId("project-row")).toHaveCount(3);
  await page.reload();
  await page.getByLabel("Search projects").fill(tag);
  await expect(page.getByTestId("project-row")).toHaveCount(3);
  await expect
    .poll(() => shownNames(page))
    .toEqual(["Charlie", "Bravo", "Alpha"].map((n) => `${tag} ${n}`));
  await expect(page.getByTestId("library-view-list")).toHaveAttribute("aria-pressed", "true");

  // Filters by creator: everything here is the user's own.
  await page.getByTestId("library-filter").getByText("Shared with me").click();
  await expect(page.getByTestId("project-row")).toHaveCount(0);
  await page.getByTestId("library-filter").getByText("Mine").click();
  await expect(page.getByTestId("project-row")).toHaveCount(3);

  // The "..." menu: the owner may edit and archive.
  const alpha = page.getByTestId("project-row").filter({ hasText: `${tag} Alpha` });
  await alpha.getByTestId("project-menu").click();
  await expect(page.getByTestId("project-menu-edit")).toBeVisible();
  await page.getByTestId("project-menu-archive").click();
  await expect(page.getByTestId("project-row")).toHaveCount(2);

  // A row opens its project.
  await page
    .getByTestId("project-row")
    .filter({ hasText: `${tag} Bravo` })
    .click();
  await expect(page.getByRole("heading", { level: 2, name: `${tag} Bravo` })).toBeVisible();
});
