import { expect, test, type Page } from "@playwright/test";
import { loginAsNewUser } from "./helpers";

// Paths are relative (no leading slash) so they resolve against the project's baseURL, which is
// either the root or `/bandroom/`. Every test runs as its own freshly created member.

test.beforeEach(async ({ page, request }, testInfo) => {
  await loginAsNewUser(page, request, testInfo);
});

function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

test("loads the library in dark mode without console errors (CSP-clean)", async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await page.goto("./");
  await expect(page).toHaveURL(/\/library$/);
  await expect(page.getByRole("heading", { level: 2, name: "Library" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", "dark");
  expect(errors).toEqual([]);
});

test("shows the navbar on desktop and the tab bar on phones", async ({ page }, testInfo) => {
  await page.goto("library");
  const isMobile = testInfo.project.use.isMobile === true;
  await expect(page.getByTestId("bottom-tab-bar")).toBeVisible({ visible: isMobile });
  await expect(page.getByTestId("desktop-nav")).toBeVisible({ visible: !isMobile });
});

test("navigates and survives a deep-link reload", async ({ page }, testInfo) => {
  await page.goto("library");
  const nav = testInfo.project.use.isMobile
    ? page.getByTestId("bottom-tab-bar")
    : page.getByTestId("desktop-nav");
  await nav.getByRole("link", { name: "Offline" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Offline" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { level: 2, name: "Offline" })).toBeVisible();
});

test("switching to Czech persists across reloads", async ({ page }) => {
  await page.goto("library");
  await page.getByTestId("language-switcher").click();
  await page.getByTestId("language-cs").click();
  await expect(page.getByRole("heading", { level: 2, name: "Knihovna" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "cs");
  await page.reload();
  await expect(page.getByRole("heading", { level: 2, name: "Knihovna" })).toBeVisible();
});

test("theme toggle switches to light and persists", async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await page.goto("library");
  // The choice is saved to the account too: reload once the server has it, or the session (still
  // "dark") wins after the reload.
  const saved = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().endsWith("/api/v1/me"),
  );
  await page.getByTestId("color-scheme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", "light");
  expect((await saved).ok()).toBe(true);
  // Record when the scheme switches during the reload: before the body exists (the inline script
  // in <head>, allowed by its CSP hash), not when React mounts (a dark flash).
  await page.addInitScript(() => {
    const seen: { scheme: string; body: boolean }[] = [];
    (window as unknown as { schemeChanges: typeof seen }).schemeChanges = seen;
    type SetAttribute = (this: Element, name: string, value: string) => void;
    const original = Object.getOwnPropertyDescriptor(Element.prototype, "setAttribute")
      ?.value as SetAttribute;
    Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
      if (this === document.documentElement && name === "data-mantine-color-scheme")
        seen.push({ scheme: value, body: document.querySelector("body") !== null });
      original.call(this, name, value);
    };
  });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", "light");
  const changes = await page.evaluate(
    () =>
      (window as unknown as { schemeChanges: { scheme: string; body: boolean }[] }).schemeChanges,
  );
  expect(changes[0]).toEqual({ scheme: "light", body: false });
  expect(changes.some((c) => c.scheme === "dark")).toBe(false);
  expect(errors).toEqual([]);
});

test("has no horizontal overflow at 360 px", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  for (const path of ["library", "me", "settings"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 2 })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
});

test("tab bar touch targets are at least 44 px", async ({ page }, testInfo) => {
  test.skip(testInfo.project.use.isMobile !== true, "phone layout only");
  await page.goto("library");
  for (const link of await page.getByTestId("bottom-tab-bar").getByRole("link").all()) {
    const box = await link.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
});

test("serves the API and health check under the base path", async ({ page, baseURL }) => {
  const request = page.request;
  const meta = await request.get(new URL("api/v1/meta", baseURL).toString());
  expect(meta.ok()).toBe(true);
  expect(await meta.json()).toMatchObject({ locales: ["en", "cs"] });
  const health = await request.get(new URL("healthz", baseURL).toString());
  expect(health.ok()).toBe(true);
});

test("the active tab is highlighted", async ({ page }, testInfo) => {
  test.skip(testInfo.project.use.isMobile !== true, "phone layout only");
  await page.goto("recent");
  const tabs = page.getByTestId("bottom-tab-bar");
  const active = tabs.getByRole("link", { name: "Recent" });
  await expect(active).toHaveAttribute("aria-current", "page");
  const color = (name: string) =>
    tabs.getByRole("link", { name }).evaluate((el) => getComputedStyle(el).color);
  expect(await color("Recent")).not.toBe(await color("Library"));
});

test("hides and restores the navigation, remembered on this device (SPEC §25.2)", async ({
  page,
}, testInfo) => {
  const isMobile = testInfo.project.use.isMobile === true;
  const nav = isMobile ? page.getByTestId("bottom-tab-bar") : page.getByTestId("desktop-nav");
  await page.goto("library");
  await expect(nav).toBeVisible();
  if (isMobile) {
    await page.getByTestId("user-menu").click();
    await page.getByTestId("chrome-hide-menu").click();
  } else {
    await page.getByTestId("chrome-hide").click();
  }
  const restore = page.getByTestId("chrome-show");
  // Phones drop the tab bar; desktop slides the navbar out.
  const navGone = () => (isMobile ? expect(nav).toHaveCount(0) : expect(nav).not.toBeInViewport());
  await expect(restore).toBeVisible();
  await navGone();
  await expect(page.getByTestId("app-header")).not.toBeInViewport();
  // The page uses the room: its heading moves to the top.
  const heading = page.getByRole("heading", { level: 2, name: "Library" });
  expect((await heading.boundingBox())?.y ?? 999).toBeLessThan(60);
  const box = await restore.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeGreaterThanOrEqual(44);

  // Still hidden after a reload and on another page.
  await page.reload();
  await expect(restore).toBeVisible();
  await page.goto("settings");
  await expect(restore).toBeVisible();
  await navGone();

  await restore.click();
  await expect(nav).toBeVisible();
  await expect(page.getByTestId("app-header")).toBeInViewport();
  await expect(restore).toHaveCount(0);

  if (!isMobile) {
    // Shift+F toggles it on every screen, but not while typing.
    await page.keyboard.press("Shift+F");
    await expect(restore).toBeVisible();
    await page.keyboard.press("Shift+F");
    await expect(restore).toHaveCount(0);
  }
});
