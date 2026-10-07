import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config";

const base = { DATA_DIR: "/tmp/bandroom-test" };

describe("loadConfig", () => {
  it("applies development defaults", () => {
    const c = loadConfig(base);
    expect(c.nodeEnv).toBe("development");
    expect(c.port).toBe(3000);
    expect(c.basePath).toBe("");
    expect(c.appUrl).toBe("http://localhost:3000");
    expect(c.purgeGcGraceMs).toBe(600_000);
    expect(loadConfig({ ...base, PURGE_GC_GRACE_SECONDS: "0" }).purgeGcGraceMs).toBe(0);
    expect(c.dbPath).toBe(path.join("/tmp/bandroom-test", "bandroom.sqlite"));
    expect(c.warnings).toHaveLength(1);
  });

  it("derives the base path from APP_URL", () => {
    expect(loadConfig({ ...base, APP_URL: "https://example.com/bandroom/" }).basePath).toBe(
      "/bandroom",
    );
  });

  it("requires APP_URL, APP_SECRET and INTERNAL_EVENTS_SECRET in production", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production" })).toThrow(ConfigError);
    const c = loadConfig({
      ...base,
      NODE_ENV: "production",
      APP_URL: "https://bandroom.example",
      APP_SECRET: "x".repeat(32),
      INTERNAL_EVENTS_SECRET: "y".repeat(32),
    });
    expect(c.isProduction).toBe(true);
    expect(c.warnings).toEqual([]);
  });

  it("rejects invalid values with readable issues", () => {
    try {
      loadConfig({ ...base, PORT: "abc", APP_SECRET: "short" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const issues = (err as ConfigError).issues.join("\n");
      expect(issues).toMatch(/PORT/);
      expect(issues).toMatch(/APP_SECRET/);
    }
  });

  it("requires DATA_DIR", () => {
    expect(() => loadConfig({})).toThrow(/DATA_DIR/);
  });

  it("parses booleans", () => {
    expect(loadConfig({ ...base, TRUST_PROXY: "true" }).trustProxy).toBe(true);
    expect(loadConfig({ ...base, TRUST_PROXY: "0" }).trustProxy).toBe(false);
  });
});
