import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";
// Relative import: the config is bundled, the workspace package (TypeScript sources) is not.
import { COLOR_SCHEME_SCRIPT } from "../../packages/shared/src/colorScheme";

/**
 * In dev, mimic the server's index.html injection with `<base href="/">` and the color scheme
 * script, so the client resolves the same app root as in production (the built index.html is
 * injected by the Fastify server, `apps/server/src/http/spa.ts`).
 */
function devBaseHref(): Plugin {
  return {
    name: "bandroom-dev-base-href",
    apply: "serve",
    transformIndexHtml: (html) =>
      html.replace(/<head>/i, (m) => `${m}<base href="/"><script>${COLOR_SCHEME_SCRIPT}</script>`),
  };
}

const API_TARGET = process.env.BANDROOM_API_URL ?? "http://localhost:3100";

export default defineConfig({
  // Relative asset URLs: the server injects <base href> at runtime, so one build works under any
  // base path (decision log, "Runtime-configurable base path").
  base: "./",
  plugins: [
    react(),
    devBaseHref(),
    // PWA (SPEC §13): our own service worker (src/sw/sw.ts) with the precache list injected.
    // Every URL is relative, so the manifest and the worker's scope follow the runtime base path
    // (manifest URLs resolve against the manifest, the worker is registered at <base>/sw.js).
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src/sw",
      filename: "sw.ts",
      injectRegister: false,
      includeManifestIcons: false,
      manifestFilename: "manifest.webmanifest",
      manifest: {
        name: "BandRoom",
        short_name: "BandRoom",
        description: "Rehearse, listen and comment with your band.",
        id: "./",
        start_url: "./",
        scope: "./",
        display: "standalone",
        background_color: "#1a1b1e",
        theme_color: "#1a1b1e",
        icons: [
          { src: "pwa-192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512.png", sizes: "512x512", type: "image/png" },
          { src: "pwa-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      injectManifest: {
        // A classic script: module service workers are not supported everywhere yet.
        rollupFormat: "iife",
        // index.html is precached as the server renders it (with <base href> and the runtime
        // config), not as built; see sw.ts.
        globPatterns: ["**/*.{js,mjs,css,wasm,woff2,svg,png}"],
        globIgnores: ["index.html", "sw.js"],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: 5180,
    strictPort: true,
    proxy: {
      "/api": API_TARGET,
      "/healthz": API_TARGET,
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
