import { expect, test } from "@playwright/test";
import { loginAsNewUser } from "./helpers";

/** M23: Settings → API keys (create → reveal once → use → revoke) and Admin → API keys (SPEC §29.4). */

test("a member creates, uses and revokes an API key", async ({ page, request }, testInfo) => {
  await loginAsNewUser(page, request, testInfo, "member");
  await page.goto("settings");
  const section = page.getByTestId("settings-api-keys");
  await expect(section.getByText("No API keys.")).toBeVisible();

  await section.getByTestId("api-key-create").click();
  await page.getByTestId("api-key-name").fill("Reaper on the studio Mac");
  // Members are not offered admin scopes.
  await expect(page.getByTestId("api-key-scope-read")).toBeVisible();
  await expect(page.getByTestId("api-key-scope-admin:read")).toHaveCount(0);
  await page.getByTestId("api-key-submit").click();

  const tokenInput = page.getByTestId("api-key-token");
  await expect(tokenInput).toBeVisible();
  const token = await tokenInput.inputValue();
  expect(token).toMatch(/^brk_[A-Za-z0-9_-]{43}$/);

  // The key works without a session or CSRF header.
  const whoami = await page.request.get("api/v1/whoami", {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(whoami.status()).toBe(200);
  expect(((await whoami.json()) as { key: { name: string } }).key.name).toBe(
    "Reaper on the studio Mac",
  );

  await page.getByTestId("api-key-done").click();
  await expect(tokenInput).toHaveCount(0);
  const row = section.getByTestId("api-key-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Reaper on the studio Mac");
  await expect(row).toContainText(token.slice(0, 10));
  await expect(row).toContainText("used");
  // The token is never shown again.
  await expect(page.getByText(token)).toHaveCount(0);

  await row.getByRole("button", { name: "Revoke Reaper on the studio Mac" }).click();
  await expect(row).toHaveCount(0);
  await expect(section.getByText("No API keys.")).toBeVisible();
  const after = await page.request.get("api/v1/whoami", {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(after.status()).toBe(401);
});

test("an admin sees admin scopes and every key in Admin", async ({ page, request }, testInfo) => {
  const username = await loginAsNewUser(page, request, testInfo, "admin");
  await page.goto("settings");
  const section = page.getByTestId("settings-api-keys");
  await section.getByTestId("api-key-create").click();
  await page.getByTestId("api-key-name").fill(`ops ${username}`);
  await page.getByRole("checkbox", { name: "Admin: read" }).check();
  await page.getByTestId("api-key-submit").click();
  await expect(page.getByTestId("api-key-token")).toBeVisible();
  await page.getByTestId("api-key-done").click();
  const row = section.getByTestId("api-key-row");
  await expect(row).toContainText("Admin: read");
  await expect(row).toContainText("Read");

  await page.goto("admin?tab=apiKeys");
  const adminRow = page.getByTestId("admin-api-key-row").filter({ hasText: `ops ${username}` });
  await expect(adminRow).toBeVisible();
  await adminRow.getByRole("button", { name: `Revoke ops ${username}` }).click();
  await expect(adminRow).toHaveCount(0);
});
