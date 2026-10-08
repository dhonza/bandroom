import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/main.ts"],
  format: "esm",
  platform: "node",
  target: "node24",
  outDir: "dist",
  fixedExtension: false,
  clean: true,
  // The practice bounce (SPEC §30.7) loads the stretcher with
  // `new URL("./stretch.wasm", import.meta.url)`, which the bundle keeps as is: ship the binary
  // next to dist/main.js.
  copy: [{ from: "../../packages/stretch/src/stretch.wasm", to: "dist" }],
  deps: {
    // Workspace packages are bundled; everything else stays external and must be a declared
    // dependency of this app. `onlyBundle` makes the build fail if anything else gets inlined
    // (e.g. a server-core dependency missing from this package.json).
    alwaysBundle: [/^@bandroom\//],
    onlyBundle: [/^@bandroom\//],
  },
});
