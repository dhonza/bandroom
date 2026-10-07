import {
  CLIENT_CONFIG_META_NAME,
  ClientConfigSchema,
  DEFAULT_LOCALE,
  normalizeBasePath,
  type ClientConfig,
} from "@bandroom/shared";

/**
 * Base path of the app, from the `<base href>` element the server injects (the Vite dev server
 * injects `<base href="/">`). Never derived from the current URL: without a `<base>` element,
 * `document.baseURI` follows client-side navigation (e.g. `/login`), which is not the app root.
 */
export function basePathFromDocument(doc: Document = document): string {
  const base = doc.querySelector("base[href]");
  if (!base) return "";
  return normalizeBasePath(new URL(base.getAttribute("href") ?? "/", doc.location.href).pathname);
}

/**
 * Reads the runtime config the server injects into `index.html`. The Vite dev server does not
 * inject it, so development falls back to defaults.
 */
export function readClientConfig(doc: Document = document): ClientConfig {
  const content = doc
    .querySelector(`meta[name="${CLIENT_CONFIG_META_NAME}"]`)
    ?.getAttribute("content");
  if (content) {
    try {
      const parsed = ClientConfigSchema.safeParse(JSON.parse(content));
      if (parsed.success) return parsed.data;
    } catch {
      // fall through to defaults
    }
  }
  return {
    appName: "BandRoom",
    version: "dev",
    basePath: basePathFromDocument(doc),
    defaultLocale: DEFAULT_LOCALE,
    logoHash: null,
  };
}
