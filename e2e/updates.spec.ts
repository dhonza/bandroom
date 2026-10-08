import { expect, test } from "@playwright/test";
import { loginAsNewUser } from "./helpers";

/** Admin → Updates (SPEC §29.8): the tab shows the running version whatever the registry says. */
test("an admin opens the Updates tab", async ({ page, request }, testInfo) => {
  await loginAsNewUser(page, request, testInfo, "admin");
  await page.goto("admin");
  await page.getByTestId("admin-updates-tab").click();
  await expect(page).toHaveURL(/tab=updates/);
  await expect(page.getByTestId("updates-running")).toHaveText(/\d+\.\d+\.\d+/, {
    timeout: 20_000,
  });
  // The registry may be unreachable from the test machine: either releases or the error.
  await expect(
    page.getByTestId("updates-release").first().or(page.getByTestId("updates-check-error")),
  ).toBeVisible({ timeout: 20_000 });
  // No host watcher in the test stack.
  await expect(page.getByTestId("updates-watcher-warning")).toBeVisible();
});
