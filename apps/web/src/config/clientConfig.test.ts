import { afterEach, describe, expect, it } from "vitest";
import { basePathFromDocument, readClientConfig } from "./clientConfig";

afterEach(() => {
  document.head.innerHTML = "";
  window.history.replaceState(null, "", "/");
});

describe("basePathFromDocument", () => {
  it("ignores the current URL when there is no <base> element", () => {
    window.history.replaceState(null, "", "/login?next=%2Fsettings");
    expect(basePathFromDocument()).toBe("");
  });

  it("reads the injected <base href>", () => {
    document.head.innerHTML = '<base href="/bandroom/">';
    window.history.replaceState(null, "", "/bandroom/settings");
    expect(basePathFromDocument()).toBe("/bandroom");
  });
});

describe("readClientConfig", () => {
  it("parses the injected meta config", () => {
    const cfg = { appName: "B", version: "1", basePath: "/x", defaultLocale: "cs" };
    document.head.innerHTML = `<meta name="bandroom-config" content='${JSON.stringify(cfg)}'>`;
    // An older server without a logo field: no logo.
    expect(readClientConfig()).toEqual({ ...cfg, logoHash: null });
    const withLogo = { ...cfg, logoHash: "ab" };
    document.head.innerHTML = `<meta name="bandroom-config" content='${JSON.stringify(withLogo)}'>`;
    expect(readClientConfig()).toEqual(withLogo);
  });

  it("falls back to defaults in Vite dev", () => {
    window.history.replaceState(null, "", "/settings");
    expect(readClientConfig()).toMatchObject({ basePath: "", appName: "BandRoom" });
  });
});
