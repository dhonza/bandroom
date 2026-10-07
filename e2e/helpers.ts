import { expect, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";

/** Created by the webServer command via `bandroom create-admin` (playwright.config.ts). */
export const ADMIN = { username: "admin", password: "e2e-admin-password" };
export const USER_PASSWORD = "e2e-user-password";

const CSRF = { "X-Requested-With": "bandroom" };

export async function apiLogin(request: APIRequestContext, login: string, password: string) {
  const res = await request.post("api/v1/auth/login", { headers: CSRF, data: { login, password } });
  if (!res.ok()) throw new Error(`login ${login} failed: ${res.status()} ${await res.text()}`);
}

/** Unique, valid username per test (≤ 32 chars). */
export function uniqueUsername(testInfo: TestInfo, prefix = "u"): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}${testInfo.workerIndex}${rand}`.toLowerCase().slice(0, 32);
}

/** Creates a user through the admin API (separate cookie jar from the page). */
export async function createUser(
  request: APIRequestContext,
  username: string,
  globalRole: "admin" | "member" | "guest" = "member",
) {
  await apiLogin(request, ADMIN.username, ADMIN.password);
  const res = await request.post("api/v1/admin/users", {
    headers: CSRF,
    data: { username, displayName: `E2E ${username}`, globalRole, password: USER_PASSWORD },
  });
  if (!res.ok()) throw new Error(`create user failed: ${res.status()} ${await res.text()}`);
}

/** Creates a fresh user and logs the page's browser context in as that user. */
export async function loginAsNewUser(
  page: Page,
  request: APIRequestContext,
  testInfo: TestInfo,
  globalRole: "admin" | "member" | "guest" = "member",
): Promise<string> {
  const username = uniqueUsername(testInfo);
  await createUser(request, username, globalRole);
  await apiLogin(page.request, username, USER_PASSWORD);
  return username;
}

export function isMobile(testInfo: TestInfo): boolean {
  return testInfo.project.use.isMobile === true;
}

/**
 * Opens the song player's Mixer (the multitrack engine, with a header per track on every screen)
 * unless it is open already, and waits for the track headers.
 */
export async function openMixer(page: Page): Promise<void> {
  const toggle = page.getByTestId("mixer-toggle");
  await toggle.waitFor({ timeout: 30_000 });
  if ((await toggle.getAttribute("aria-pressed")) === "true") return;
  await toggle.click();
  await page.getByTestId("rehearse-panel").waitFor({ timeout: 30_000 });
  await page.getByTestId("track-strip").first().waitFor({ timeout: 30_000 });
}

/**
 * Closes the Mixer, waiting until a track is ready: the closed Mixer plays the tracks through the
 * engine (no rendered mix since M21, SPEC §27; group C makes this the only player panel).
 */
export async function closeMixer(page: Page, timeout = 120_000): Promise<void> {
  const toggle = page.getByTestId("mixer-toggle").first();
  const closed = page.getByTestId("default-mix-panel");
  // Until a track is ready there is nothing to play yet.
  await expect(toggle.or(closed).first()).toBeVisible({ timeout });
  if ((await toggle.getAttribute("aria-pressed")) === "true") await toggle.click();
  await closed.waitFor({ timeout });
}

/**
 * Where to tap a track header's settings button: on phones it covers the whole header with M/S on
 * top, so tap the name line (top left); on wide headers it is the ⚙ icon itself.
 */
export const TAP_NAME = { position: { x: 12, y: 8 } };
