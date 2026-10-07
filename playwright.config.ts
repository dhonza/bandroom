import { defineConfig, devices } from "@playwright/test";

/**
 * E2E runs against the production build (`pnpm build`): the Fastify server serves the built SPA.
 * Two servers cover both hosting modes: at the root and under `/bandroom`.
 */
const ROOT_PORT = 3201;
const SUBPATH_PORT = 3202;
const ROOT_URL = `http://localhost:${ROOT_PORT}/`;
const SUBPATH_URL = `http://localhost:${SUBPATH_PORT}/bandroom/`;

function server(port: number, appUrl: string, name: string, samplyMockPort: number) {
  const dataDir = `.data/e2e-${name}`;
  return {
    // Fresh data dir, bootstrap admin via the real CLI, then start the server.
    command:
      `rm -rf ${dataDir} && ` +
      `echo e2e-admin-password | node apps/server/dist/cli.js create-admin --username admin --display-name Admin --password-stdin && ` +
      `node e2e/start-stack.mjs`,
    url: `http://localhost:${port}/healthz`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      NODE_ENV: "test",
      PORT: String(port),
      HOST: "127.0.0.1",
      APP_URL: appUrl,
      DATA_DIR: dataDir,
      WEB_DIST_DIR: "apps/web/dist",
      LOG_LEVEL: "warn",
      SAMPLY_MOCK_PORT: String(samplyMockPort),
    },
  };
}

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    // Every fresh context would install the service worker and precache ~4 MB; only the offline
    // spec needs it (it opts in with `serviceWorkers: "allow"`).
    serviceWorkers: "block",
    trace: "retain-on-failure",
    colorScheme: "dark",
    locale: "en-US",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], baseURL: ROOT_URL } },
    { name: "webkit", use: { ...devices["Desktop Safari"], baseURL: ROOT_URL } },
    { name: "iphone", use: { ...devices["iPhone 15"], baseURL: ROOT_URL } },
    { name: "pixel", use: { ...devices["Pixel 7"], baseURL: ROOT_URL } },
    { name: "subpath-chromium", use: { ...devices["Desktop Chrome"], baseURL: SUBPATH_URL } },
    { name: "subpath-iphone", use: { ...devices["iPhone 15"], baseURL: SUBPATH_URL } },
  ],
  webServer: [
    server(ROOT_PORT, ROOT_URL, "root", ROOT_PORT + 100),
    server(SUBPATH_PORT, SUBPATH_URL, "subpath", SUBPATH_PORT + 100),
  ],
});
