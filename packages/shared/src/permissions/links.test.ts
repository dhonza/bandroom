import { describe, expect, it } from "vitest";
import {
  linkCanDownload,
  linkCapabilities,
  linkHasCapability,
  linkPlayerMode,
  linkRole,
  linkShowsComment,
  linkShowsVersion,
  linkStatus,
  type LinkPolicy,
} from "./links";

const base: LinkPolicy = {
  scopeType: "song",
  content: "all-tracks",
  versions: "all",
  versionIds: [],
  allowDownload: false,
  allowComments: false,
  showComments: false,
};

const v = (over: Partial<Parameters<typeof linkShowsVersion>[1]> = {}) => ({
  versionId: "v1",
  trackRole: "track" as const,
  trackIsSystem: false,
  isCurrent: true,
  ...over,
});

describe("linkStatus", () => {
  const now = 1000;
  it.each([
    [{ active: true, revokedAt: null, expiresAt: null }, "active"],
    [{ active: true, revokedAt: null, expiresAt: 2000 }, "active"],
    [{ active: false, revokedAt: null, expiresAt: null }, "inactive"],
    [{ active: true, revokedAt: null, expiresAt: 1000 }, "expired"],
    [{ active: false, revokedAt: null, expiresAt: 500 }, "expired"],
    [{ active: true, revokedAt: 10, expiresAt: 500 }, "revoked"],
  ] as const)("%o → %s", (link, status) => {
    expect(linkStatus(link, now)).toBe(status);
  });
});

describe("capabilities", () => {
  it("is a viewer without comments and a commenter with them", () => {
    expect(linkRole(base)).toBe("viewer");
    expect(linkRole({ allowComments: true })).toBe("commenter");
  });

  it.each([
    [false, false, ["view", "stream"]],
    [true, false, ["view", "stream", "comment"]],
    [false, true, ["view", "stream", "download"]],
    [true, true, ["view", "stream", "comment", "download"]],
  ] as const)("comments %s downloads %s → %o", (allowComments, allowDownload, caps) => {
    expect(linkCapabilities({ allowComments, allowDownload })).toEqual(caps);
  });

  it("never grants contributor or editor capabilities", () => {
    const all = { allowComments: true, allowDownload: true };
    for (const cap of ["upload", "annotate.own", "edit.any", "link.manage", "tempo.edit"] as const)
      expect(linkHasCapability(all, cap)).toBe(false);
    expect(linkHasCapability(all, "comment")).toBe(true);
  });

  it("downloads need the link flag and a policy that lets viewers download", () => {
    expect(linkCanDownload({ allowDownload: true }, "all")).toBe(true);
    expect(linkCanDownload({ allowDownload: true }, "contributors")).toBe(false);
    expect(linkCanDownload({ allowDownload: true }, "editors")).toBe(false);
    expect(linkCanDownload({ allowDownload: false }, "all")).toBe(false);
  });
});

describe("linkShowsVersion", () => {
  it("all tracks, all versions: everything", () => {
    expect(linkShowsVersion(base, v({ isCurrent: false }))).toBe(true);
    expect(linkShowsVersion(base, v({ trackIsSystem: true }))).toBe(true);
  });

  it("current-only hides older versions", () => {
    const l = { ...base, versions: "current-only" as const };
    expect(linkShowsVersion(l, v())).toBe(true);
    expect(linkShowsVersion(l, v({ isCurrent: false }))).toBe(false);
  });

  it("mix-only shows mix tracks and the automatic mix only", () => {
    const l = { ...base, content: "mix-only" as const };
    expect(linkShowsVersion(l, v())).toBe(false);
    expect(linkShowsVersion(l, v({ trackRole: "mix" }))).toBe(true);
    expect(linkShowsVersion(l, v({ trackIsSystem: true }))).toBe(true);
    expect(
      linkShowsVersion(
        { ...l, versions: "current-only" },
        v({ trackRole: "mix", isCurrent: false }),
      ),
    ).toBe(false);
  });

  it("versions links show exactly the listed versions", () => {
    const l = { ...base, scopeType: "versions" as const, versionIds: ["v1"] };
    expect(linkShowsVersion(l, v({ isCurrent: false }))).toBe(true);
    expect(linkShowsVersion(l, v({ versionId: "v2" }))).toBe(false);
    expect(linkShowsVersion(l, v({ versionId: "v2", trackIsSystem: true }))).toBe(false);
  });
});

describe("linkShowsComment", () => {
  it("shows only the link's own comments unless band comments are shown", () => {
    expect(linkShowsComment(base, "L1", { linkId: "L1" })).toBe(true);
    expect(linkShowsComment(base, "L1", { linkId: null })).toBe(false);
    expect(linkShowsComment(base, "L1", { linkId: "L2" })).toBe(false);
    expect(linkShowsComment({ showComments: true }, "L1", { linkId: null })).toBe(true);
  });
});

describe("linkPlayerMode", () => {
  it.each([
    ["song", "mix-only", 3, "listen"],
    ["project", "all-tracks", 1, "rehearse"],
    ["song", "all-tracks", 4, "rehearse"],
    ["versions", "all-tracks", 1, "listen"],
    ["versions", "all-tracks", 2, "rehearse"],
  ] as const)("%s %s with %d tracks → %s", (scopeType, content, n, mode) => {
    expect(linkPlayerMode({ scopeType, content }, n)).toBe(mode);
  });
});
