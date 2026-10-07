import { create } from "zustand";
import { writeSwUser } from "./swState";

/** `beforeinstallprompt` (Chromium browsers); not in the DOM typings. */
export interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

interface PwaState {
  /** A new version is installed and waits for "Reload" (SPEC §13: no silent reload). */
  waiting: ServiceWorker | null;
  /** The browser's install prompt, when it offered one. */
  installPrompt: InstallPromptEvent | null;
  /** The service worker controls this page (offline caching works). */
  controlled: boolean;
}

export const usePwa = create<PwaState>(() => ({
  waiting: null,
  installPrompt: null,
  controlled: false,
}));

/** Running as an installed app (home screen / standalone window). */
export function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
}

/** iPhone/iPad Safari, where "Add to Home Screen" is manual (and iPadOS reports a Mac). */
export function isIos(ua = navigator.userAgent, touchPoints = navigator.maxTouchPoints): boolean {
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);
}

export function listenForInstallPrompt(): void {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    usePwa.setState({ installPrompt: e as InstallPromptEvent });
  });
  window.addEventListener("appinstalled", () => {
    usePwa.setState({ installPrompt: null });
  });
}

export async function promptInstall(): Promise<boolean> {
  const p = usePwa.getState().installPrompt;
  if (!p) return false;
  await p.prompt();
  const { outcome } = await p.userChoice;
  usePwa.setState({ installPrompt: null });
  return outcome === "accepted";
}

let registration: ServiceWorkerRegistration | null = null;

function trackWaiting(reg: ServiceWorkerRegistration): void {
  const check = () => {
    // Only an update waits: the first install activates at once (no controller yet).
    if (reg.waiting && navigator.serviceWorker.controller)
      usePwa.setState({ waiting: reg.waiting });
  };
  check();
  reg.addEventListener("updatefound", () => {
    const sw = reg.installing;
    sw?.addEventListener("statechange", () => {
      if (sw.state === "installed") check();
    });
  });
}

/**
 * Registers `<base>/sw.js` with the app root as its scope (SPEC §13, DECISIONS "Runtime-configurable
 * base path"). Production builds only; the Vite dev server has no service worker.
 */
export async function registerServiceWorker(): Promise<void> {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  const root = new URL("./", document.baseURI).href;
  try {
    const reg = await navigator.serviceWorker.register(new URL("sw.js", root).href, {
      scope: root,
    });
    registration = reg;
    trackWaiting(reg);
    usePwa.setState({ controlled: navigator.serviceWorker.controller !== null });
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      usePwa.setState({ controlled: true });
    });
    // Look for new versions now and then (the browser also checks on navigation).
    window.setInterval(() => void reg.update().catch(() => undefined), 60 * 60_000);
  } catch {
    // Unsupported or blocked (e.g. private mode): the app works online only.
  }
}

/** "Reload": activates the waiting version and reloads once it controls the page. */
export function applyUpdate(): void {
  const waiting = usePwa.getState().waiting;
  if (!waiting) {
    window.location.reload();
    return;
  }
  navigator.serviceWorker.addEventListener(
    "controllerchange",
    () => {
      window.location.reload();
    },
    { once: true },
  );
  waiting.postMessage({ type: "SKIP_WAITING" });
}

/** Tells the worker whose offline data it may serve (after login, session load and logout). */
export async function setServiceWorkerUser(userId: string | null): Promise<void> {
  await writeSwUser(userId);
  if (!("serviceWorker" in navigator)) return;
  const msg = { type: "SET_USER", userId };
  navigator.serviceWorker.controller?.postMessage(msg);
  registration?.active?.postMessage(msg);
}
