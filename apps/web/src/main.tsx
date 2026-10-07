import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "@mantine/dropzone/styles.css";
import "@fontsource-variable/inter";
import "./styles/global.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { setApiBasePath } from "./api/client";
import { setMediaBasePath } from "./lib/media";
import { renderBootError } from "./app/bootError";
import { Providers } from "./app/Providers";
import { routes } from "./app/routes";
import { readClientConfig } from "./config/clientConfig";
import { detectLanguage, initI18n } from "./i18n/i18n";
import { watchOnlineState } from "./offline/online";
import { listenForInstallPrompt, registerServiceWorker } from "./offline/pwa";

async function bootstrap(): Promise<void> {
  const config = readClientConfig();
  document.title = config.appName;
  setApiBasePath(config.basePath);
  setMediaBasePath(config.basePath);
  const i18n = await initI18n(detectLanguage(config.defaultLocale));
  const router = createBrowserRouter(routes, { basename: config.basePath || "/" });
  watchOnlineState();
  listenForInstallPrompt();
  // Public-link visitors get no service worker: nothing of theirs is kept offline (SPEC §3.5).
  if (!window.location.pathname.slice(config.basePath.length).startsWith("/l/")) {
    void registerServiceWorker();
  }

  const root = document.getElementById("root");
  if (root === null) throw new Error("#root element missing");
  createRoot(root).render(
    <StrictMode>
      <Providers config={config} i18n={i18n}>
        <RouterProvider router={router} />
      </Providers>
    </StrictMode>,
  );
}

bootstrap().catch((err: unknown) => {
  console.error(err);
  const root = document.getElementById("root");
  if (root) renderBootError(root);
});
