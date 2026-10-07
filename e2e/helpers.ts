import { expect, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { crc32 } from "node:zlib";

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
 * Opens the Mixer (the header's Mixer button; SPEC §11.3) unless it is open already, and waits for
 * the track headers.
 */
export async function openMixer(page: Page): Promise<void> {
  const toggle = page.getByTestId("mixer-toggle");
  await toggle.waitFor({ timeout: 30_000 });
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("rehearse-panel").waitFor({ timeout: 30_000 });
  await page.getByTestId("track-strip").first().waitFor({ timeout: 30_000 });
}

/**
 * Closes the Mixer and waits for the Player, which needs a track ready to play: the Player always
 * plays the tracks through the engine (SPEC §27.4).
 */
export async function closeMixer(page: Page, timeout = 120_000): Promise<void> {
  const toggle = page.getByTestId("mixer-toggle");
  await toggle.waitFor({ timeout });
  if ((await toggle.getAttribute("aria-pressed")) === "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("rehearse-play")).toBeEnabled({ timeout });
  await expect(page.getByTestId("track-strip")).toHaveCount(0);
}

/**
 * Where to tap a track header's settings button: on phones it covers the whole header with M/S on
 * top, so tap the name line (top left); on wide headers it is the ⚙ icon itself.
 */
export const TAP_NAME = { position: { x: 12, y: 8 } };

/** A minimal STORED zip (no compression) for upload tests (SPEC §28.1). */
export function storedZip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, e.data);
    centrals.push(central, name);
    offset += 30 + name.length + e.data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
