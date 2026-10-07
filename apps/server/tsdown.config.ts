import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/main.ts", "src/cli.ts"],
  format: "esm",
  platform: "node",
  target: "node24",
  outDir: "dist",
  fixedExtension: false,
  clean: true,
  deps: {
    // Workspace packages are bundled; everything else stays external and must be a declared
    // dependency of this app. `onlyBundle` makes the build fail if anything else gets inlined
    // (e.g. a server-core dependency missing from this package.json).
    alwaysBundle: [/^@bandroom\//],
    onlyBundle: [/^@bandroom\//],
  },
});
