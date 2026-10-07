import { describe, expect, it } from "vitest";
import {
  codeOf,
  hashOfVersion,
  makeLink,
  mixV1,
  openAs,
  projectId,
  setupLinkFixtures,
  songId,
  tokenOf,
  visit,
} from "../testing/linkFixtures";

setupLinkFixtures();

describe("visitor route matrix", () => {
  type Row = { method: "GET" | "POST" | "PUT"; path: () => string; body?: unknown; cap: string };
  const ROWS: Row[] = [
    { method: "GET", path: () => `/songs/${songId}`, cap: "view" },
    { method: "GET", path: () => `/songs/${songId}/tracks`, cap: "view" },
    { method: "GET", path: () => `/songs/${songId}/markers`, cap: "view" },
    { method: "GET", path: () => `/songs/${songId}/tempo`, cap: "view" },
    { method: "GET", path: () => `/songs/${songId}/comments`, cap: "view" },
    { method: "GET", path: () => `/projects/${projectId}/songs`, cap: "view" },
    { method: "GET", path: () => `/projects/${projectId}/queue`, cap: "view" },
    { method: "GET", path: () => `/blobs/${hashOfVersion(mixV1)}`, cap: "stream" },
    {
      method: "POST",
      path: () => `/songs/${songId}/played`,
      body: { mode: "listen" },
      cap: "stream",
    },
    {
      method: "POST",
      path: () => `/songs/${songId}/comments`,
      body: { body: "x" },
      cap: "comment",
    },
    { method: "PUT", path: () => "/visitor", body: { name: "N" }, cap: "comment" },
    {
      method: "GET",
      path: () => `/track-versions/${mixV1}/download?format=opus`,
      cap: "download",
    },
  ];
  // Band-only endpoints do not exist below /l/:token at all.
  const BAND_ONLY: Row[] = [
    { method: "PUT", path: () => `/songs/${songId}/tempo`, body: {}, cap: "tempo" },
    { method: "POST", path: () => `/songs/${songId}/markers`, body: {}, cap: "markers" },
    { method: "GET", path: () => `/songs/${songId}/mixer`, cap: "mixer" },
    { method: "GET", path: () => `/songs/${songId}/documents`, cap: "documents" },
    { method: "GET", path: () => `/songs/${songId}/links`, cap: "links" },
    { method: "GET", path: () => "/me", cap: "me" },
    // Listen mode was removed (SPEC §27): no such route at all.
    { method: "GET", path: () => `/songs/${songId}/listen`, cap: "listen" },
  ];

  for (const r of ROWS) {
    it(`${r.method} ${r.cap} route: no session → UNAUTHENTICATED, viewer link → ${r.cap === "comment" || r.cap === "download" ? "FORBIDDEN" : "ok"}`, async () => {
      const link = await makeLink({ scopeType: "song" });
      const token = tokenOf(link);
      const none = await visit(token, r.method, r.path(), { body: r.body });
      expect(codeOf(none)).toBe("UNAUTHENTICATED");
      const cookie = await openAs(link);
      const res = await visit(token, r.method, r.path(), { cookie, body: r.body });
      const want = r.cap === "comment" || r.cap === "download" ? "FORBIDDEN" : "ok";
      expect(codeOf(res)).toBe(want);
    });
  }

  for (const r of BAND_ONLY) {
    it(`${r.method} ${r.cap} is not a visitor route`, async () => {
      const link = await makeLink({ scopeType: "song" });
      const cookie = await openAs(link);
      const res = await visit(tokenOf(link), r.method, r.path(), { cookie, body: r.body });
      expect(res.statusCode).toBe(404);
    });
  }
});
