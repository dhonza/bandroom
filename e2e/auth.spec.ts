import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { ADMIN, createUser, isMobile, uniqueUsername, USER_PASSWORD } from "./helpers";

/**
 * M1 acceptance: invite → login → settings in both languages, plus the email-free password reset.
 * Full flows run on one desktop and one phone project per server (public token endpoints are rate
 * limited per IP, and all tests share 127.0.0.1).
 */
const FLOW_PROJECTS = new Set(["chromium", "iphone", "subpath-chromium"]);

function onlyFlowProjects(testInfo: TestInfo) {
  test.skip(!FLOW_PROJECTS.has(testInfo.project.name), "full auth flows run on selected projects");
  // Several argon2 hashes and page loads per flow; generous on loaded machines and in CI.
  test.setTimeout(60_000);
}

const EN = { login: "Username or email", password: "Password", submit: "Log in" };

async function loginViaUi(page: Page, login: string, password: string, expectOk = true) {
  await page.goto("login");
  await page.getByLabel(EN.login).fill(login);
  await page.getByLabel(EN.password, { exact: true }).fill(password);
  await page.getByRole("button", { name: EN.submit }).click();
  // Wait for the session before navigating on, or the next goto races the login request.
  if (expectOk) await expect(page).not.toHaveURL(/\/login/);
}

async function logoutViaUi(page: Page, testInfo: TestInfo, logoutLabel: string) {
  if (isMobile(testInfo)) {
    await page.goto("me");
    await page.getByRole("button", { name: logoutLabel }).click();
  } else {
    await page.getByTestId("user-menu").click();
    await page.getByTestId("logout").click();
  }
  await expect(page).toHaveURL(/\/login/);
}

async function adminCreatesInviteLink(page: Page): Promise<string> {
  await loginViaUi(page, ADMIN.username, ADMIN.password);
  await page.goto("admin");
  await page.getByTestId("invite-button").click();
  await page.getByTestId("invite-submit").click();
  const link = await page.getByTestId("one-time-link").inputValue();
  expect(link).toMatch(/\/invite\/[A-Za-z0-9_-]{43}$/);
  return link;
}

test.describe("invite → login → settings", () => {
  test("in English", async ({ browser, baseURL }, testInfo) => {
    onlyFlowProjects(testInfo);
    const adminCtx = await browser.newContext({ baseURL });
    const inviteLink = await adminCreatesInviteLink(await adminCtx.newPage());
    await adminCtx.close();

    const ctx = await browser.newContext({ ...testInfo.project.use, baseURL, locale: "en-US" });
    const page = await ctx.newPage();
    const username = uniqueUsername(testInfo, "inv");

    await page.goto(inviteLink);
    await expect(page.getByRole("heading", { name: "Join the band" })).toBeVisible();
    await page.getByLabel("Username", { exact: true }).fill(username);
    await page.getByLabel("Display name").fill("Invited Person");
    await page.getByLabel("Password", { exact: true }).fill(USER_PASSWORD);
    await page.getByLabel("Repeat password").fill(USER_PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Library" })).toBeVisible({
      timeout: 15_000,
    });

    // Settings: profile and password.
    await page.goto("settings");
    const profile = page.getByTestId("settings-profile");
    await profile.getByLabel("Display name").fill("Renamed Person");
    await profile.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();

    const pw = page.getByTestId("settings-password");
    await pw.getByLabel("Current password").fill(USER_PASSWORD);
    await pw.getByLabel("New password").fill("a-brand-new-password");
    await pw.getByLabel("Repeat password").fill("a-brand-new-password");
    await pw.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText("Password changed.", { exact: false })).toBeVisible();

    await logoutViaUi(page, testInfo, "Log out");
    await loginViaUi(page, username, USER_PASSWORD, false);
    await expect(page.getByTestId("login-error")).toHaveText("Wrong username or password.");
    await loginViaUi(page, username, "a-brand-new-password");
    await expect(page.getByRole("heading", { level: 2, name: "Library" })).toBeVisible({
      timeout: 15_000,
    });
    if (!isMobile(testInfo)) {
      await page.getByTestId("user-menu").click();
      await expect(page.getByText("Renamed Person")).toBeVisible();
    }
    await ctx.close();
  });

  test("in Czech", async ({ browser, baseURL }, testInfo) => {
    onlyFlowProjects(testInfo);
    const adminCtx = await browser.newContext({ baseURL });
    const inviteLink = await adminCreatesInviteLink(await adminCtx.newPage());
    await adminCtx.close();

    // Browser language Czech → the invite page is Czech from the start.
    const ctx = await browser.newContext({ ...testInfo.project.use, baseURL, locale: "cs-CZ" });
    const page = await ctx.newPage();
    const username = uniqueUsername(testInfo, "cz");

    await page.goto(inviteLink);
    await expect(page.getByRole("heading", { name: "Přidejte se ke kapele" })).toBeVisible();
    await page.getByLabel("Uživatelské jméno", { exact: true }).fill(username);
    await page.getByLabel("Zobrazované jméno").fill("Jana Nováková");
    await page.getByLabel("Heslo", { exact: true }).fill(USER_PASSWORD);
    await page.getByLabel("Heslo znovu").fill(USER_PASSWORD);
    await page.getByRole("button", { name: "Vytvořit účet" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Knihovna" })).toBeVisible({
      timeout: 15_000,
    });

    await page.goto("settings");
    await expect(page.getByRole("heading", { level: 2, name: "Nastavení" })).toBeVisible();
    await expect(page.getByTestId("settings-sessions").getByText("toto zařízení")).toBeVisible();

    // The language chosen on the invite page is stored on the account: a new device shows Czech
    // even with an English browser.
    await logoutViaUi(page, testInfo, "Odhlásit se");
    const enCtx = await browser.newContext({ ...testInfo.project.use, baseURL, locale: "en-US" });
    const enPage = await enCtx.newPage();
    await loginViaUi(enPage, username, USER_PASSWORD);
    await expect(enPage.getByRole("heading", { level: 2, name: "Knihovna" })).toBeVisible({
      timeout: 15_000,
    });
    await enCtx.close();
    await ctx.close();
  });
});

test("forgot password → admin reset link → new password", async ({
  browser,
  baseURL,
  request,
}, testInfo) => {
  onlyFlowProjects(testInfo);
  const username = uniqueUsername(testInfo, "fp");
  await createUser(request, username);

  const ctx = await browser.newContext({ ...testInfo.project.use, baseURL, locale: "en-US" });
  const page = await ctx.newPage();
  await page.goto("login");
  await page.getByLabel("Username or email").fill(username);
  await page.getByRole("button", { name: "Forgot password?" }).click();
  await page.getByRole("button", { name: "Ask an admin" }).click();
  await expect(page.getByTestId("forgot-done")).toBeVisible();

  const adminCtx = await browser.newContext({ baseURL });
  const admin = await adminCtx.newPage();
  await loginViaUi(admin, ADMIN.username, ADMIN.password);
  await admin.goto("admin");
  await expect(admin.getByTestId("reset-requests")).toBeVisible();
  const row = admin.locator(`[data-testid="admin-user-row"][data-username="${username}"]`);
  await expect(row.getByTestId("reset-requested")).toBeVisible();
  await row.getByTestId("user-actions").click();
  await admin.getByTestId("create-reset-link").click();
  const resetLink = await admin.getByTestId("one-time-link").inputValue();
  await adminCtx.close();

  await page.goto(resetLink);
  await expect(page.getByText(`@${username}`)).toBeVisible();
  await page.getByLabel("New password").fill("reset-new-password");
  await page.getByLabel("Repeat password").fill("reset-new-password");
  await page.getByRole("button", { name: "Save password" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Library" })).toBeVisible({
    timeout: 15_000,
  });

  await page.goto(resetLink);
  await expect(page.getByTestId("reset-invalid")).toBeVisible();
  await ctx.close();
});

test("anonymous visitors are sent to login and back", async ({ page, request }, testInfo) => {
  const username = uniqueUsername(testInfo, "nx");
  await createUser(request, username);
  await page.goto("settings");
  await expect(page).toHaveURL(/\/login\?next=%2Fsettings$/);
  await page.getByLabel(EN.login).fill(username);
  await page.getByLabel(EN.password, { exact: true }).fill(USER_PASSWORD);
  await page.getByRole("button", { name: EN.submit }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("heading", { level: 2, name: "Settings" })).toBeVisible();
});
