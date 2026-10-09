import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*", "tools/*"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**", "apps/*/src/**"],
      exclude: ["**/*.test.{ts,tsx}", "**/*.d.ts", "**/testing/**", "**/test/**"],
      // SPEC §20: permissions and tempo math must stay at 100% line coverage.
      thresholds: {
        "packages/shared/src/permissions/**": { lines: 100, branches: 100, functions: 100 },
        "packages/shared/src/tempo/**": { lines: 100, branches: 100, functions: 100 },
        // SPEC §24.17: the edit model and the timeline remap.
        "packages/shared/src/edit/**": { lines: 100, functions: 100 },
        "packages/audio-engine/src/tempo.ts": { lines: 100, branches: 100, functions: 100 },
        "apps/web/src/tempo/model.ts": { lines: 100, branches: 100, functions: 100 },
        "packages/shared/src/instruments.ts": { lines: 100, functions: 100 },
      },
    },
  },
});
