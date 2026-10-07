// @vitest-environment node
import { describe, expect, it } from "vitest";
import { classify, isSessionUrl } from "./routing";

const H = "a".repeat(64);

describe.each([
  { label: "root", scope: "https://band.test/" },
  { label: "sub-path", scope: "https://band.test/bandroom/" },
])("classify at $label", ({ scope }) => {
  const get = (path: string, mode = "cors") =>
    classify({ method: "GET", mode, url: scope + path }, scope);

  it("routes app pages, the build and the API", () => {
    expect(get("songs/1", "navigate")).toBe("navigate");
    expect(get("", "navigate")).toBe("navigate");
    expect(get("assets/index-abc.js")).toBe("static");
    expect(get(`api/v1/blobs/${H}`)).toBe("blob");
    expect(get("api/v1/songs/1/tracks")).toBe("api");
    expect(get("api/v1/songs/1/comments?cursor=x")).toBe("api");
    expect(get("api/v1/document-versions/1/content")).toBe("api");
  });

  it("leaves mutations, SSE, uploads, downloads and public links alone", () => {
    expect(
      classify({ method: "POST", mode: "cors", url: `${scope}api/v1/songs/1/comments` }, scope),
    ).toBe("bypass");
    expect(get("api/v1/stream")).toBe("bypass");
    expect(get("api/v1/uploads/abc")).toBe("bypass");
    expect(get("api/v1/track-versions/1/download?format=wav", "navigate")).toBe("bypass");
    expect(get("api/v1/document-versions/1/download")).toBe("bypass");
    expect(get("api/v1/projects/1/export/download?format=wav")).toBe("bypass");
    expect(get(`api/v1/l/tok/blobs/${H}`)).toBe("bypass");
    expect(get("api/v1/l/tok/songs/1")).toBe("bypass");
    expect(get("healthz")).toBe("bypass");
    expect(get("sw.js")).toBe("bypass");
  });

  it("ignores other origins and paths outside the scope", () => {
    expect(
      classify({ method: "GET", mode: "cors", url: "https://other.test/api/v1/x" }, scope),
    ).toBe("bypass");
    if (scope.endsWith("/bandroom/")) {
      expect(
        classify({ method: "GET", mode: "navigate", url: "https://band.test/other" }, scope),
      ).toBe("bypass");
    }
  });

  it("recognizes the session endpoint", () => {
    expect(isSessionUrl(`${scope}api/v1/auth/session`, scope)).toBe(true);
    expect(isSessionUrl(`${scope}api/v1/auth/login`, scope)).toBe(false);
  });
});
