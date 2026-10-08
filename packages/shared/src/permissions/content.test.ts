import { describe, expect, it } from "vitest";
import {
  blockedBySongLock,
  canActOn,
  canDeleteContent,
  canPurgeContent,
  canPurgeContainer,
  canRestoreContainer,
  canAddSongsTo,
  canBounce,
  canCopyContent,
  canMoveContent,
  canRemoveLossless,
  canRestoreContent,
  canActOnComment,
  CAPABILITIES,
  canDownload,
  capabilitiesOf,
  CONTENT_ROLES,
  DEFAULT_MIX_FIELDS,
  TRACK_LOCK_FIELDS,
  DEFAULT_PROJECT_ROLES,
  effectiveDownloadPolicy,
  effectiveRole,
  hasCapability,
  lockedOut,
  projectVisibility,
  roleAtLeast,
  TRASH_KINDS,
  VERSION_GAIN_FIELDS,
  type Capability,
  type ContentRole,
  type EffectiveRole,
} from "./content";
import type { GlobalRole } from "./global";

const user = (globalRole: GlobalRole, disabledAt: number | null = null) => ({
  globalRole,
  disabledAt,
});
const defaults = DEFAULT_PROJECT_ROLES;

/** Expected capability matrix, written out by hand from SPEC §3.2 (not derived from the code). */
const MATRIX: Record<EffectiveRole, readonly Capability[]> = {
  none: [],
  viewer: ["view", "stream", "download"],
  commenter: ["view", "stream", "download", "comment"],
  contributor: [
    "view",
    "stream",
    "download",
    "comment",
    "upload",
    "record",
    "annotate.own",
    "edit.own",
    "delete.own",
  ],
  editor: [
    "view",
    "stream",
    "download",
    "comment",
    "upload",
    "record",
    "annotate.own",
    "edit.own",
    "delete.own",
    "annotate.any",
    "edit.any",
    "delete.any",
    "tempo.edit",
    "version.setCurrent",
    "song.create",
    "link.manage",
  ],
  manager: [...CAPABILITIES],
  admin: [...CAPABILITIES],
};

describe("capability matrix (SPEC §3.2)", () => {
  for (const role of [...CONTENT_ROLES, "admin"] as const) {
    for (const cap of CAPABILITIES) {
      const want = MATRIX[role].includes(cap);
      it(`${role} ${want ? "has" : "lacks"} ${cap}`, () => {
        expect(hasCapability(role, cap)).toBe(want);
      });
    }
    it(`capabilitiesOf(${role})`, () => {
      expect(new Set(capabilitiesOf(role))).toEqual(new Set(MATRIX[role]));
    });
  }

  it("orders roles", () => {
    expect(roleAtLeast("editor", "contributor")).toBe(true);
    expect(roleAtLeast("contributor", "editor")).toBe(false);
    expect(roleAtLeast("admin", "manager")).toBe(true);
    expect(roleAtLeast("none", "viewer")).toBe(false);
  });
});

describe("effectiveRole (SPEC §3.3)", () => {
  const cases: [string, Parameters<typeof effectiveRole>[0], EffectiveRole][] = [
    ["anonymous → none", { user: null, defaults }, "none"],
    ["disabled admin → none", { user: user("admin", 5), defaults }, "none"],
    [
      "admin bypasses a none grant",
      { user: user("admin"), projectGrant: "none", songGrant: "none", defaults },
      "admin",
    ],
    ["member default", { user: user("member"), defaults }, "contributor"],
    ["guest default", { user: user("guest"), defaults }, "none"],
    [
      "custom defaults",
      { user: user("guest"), defaults: { member: "viewer", guest: "viewer" } },
      "viewer",
    ],
    [
      "project grant beats default",
      { user: user("member"), projectGrant: "editor", defaults },
      "editor",
    ],
    [
      "project none denies a member",
      { user: user("member"), projectGrant: "none", defaults },
      "none",
    ],
    [
      "song grant raises a guest",
      { user: user("guest"), songGrant: "commenter", defaults },
      "commenter",
    ],
    [
      "song grant restricts",
      { user: user("member"), projectGrant: "manager", songGrant: "viewer", defaults },
      "viewer",
    ],
    [
      "song none hides from a member",
      { user: user("member"), songGrant: "none", defaults },
      "none",
    ],
    [
      "null grants fall through",
      { user: user("member"), projectGrant: null, songGrant: null, defaults },
      "contributor",
    ],
  ];
  it.each(cases)("%s", (_name, input, expected) => {
    expect(effectiveRole(input)).toBe(expected);
  });
});

describe("projectVisibility", () => {
  const cases: [EffectiveRole, ContentRole[], string][] = [
    ["viewer", [], "full"],
    ["admin", [], "full"],
    ["none", [], "hidden"],
    ["none", ["none"], "hidden"],
    ["none", ["none", "commenter"], "reduced"],
    ["contributor", ["none"], "full"],
  ];
  it.each(cases)("%s with song grants %j → %s", (role, grants, expected) => {
    expect(projectVisibility(role, grants)).toBe(expected);
  });
});

describe("download policy (SPEC §3.4)", () => {
  it("inherits from the project", () => {
    expect(effectiveDownloadPolicy("inherit", "editors")).toBe("editors");
    expect(effectiveDownloadPolicy(null, "all")).toBe("all");
    expect(effectiveDownloadPolicy("contributors", "all")).toBe("contributors");
  });

  const cases: [EffectiveRole, "all" | "contributors" | "editors", boolean][] = [
    ["none", "all", false],
    ["viewer", "all", true],
    ["viewer", "contributors", false],
    ["contributor", "contributors", true],
    ["contributor", "editors", false],
    ["editor", "editors", true],
    ["admin", "editors", true],
  ];
  it.each(cases)("%s under %s → %s", (role, policy, expected) => {
    expect(canDownload(role, policy)).toBe(expected);
  });
});

describe("canActOn (own vs any)", () => {
  it.each([
    ["contributor", "delete", true, true],
    ["contributor", "delete", false, false],
    ["editor", "delete", false, true],
    ["commenter", "edit", true, false],
    ["contributor", "annotate", true, true],
    ["admin", "edit", false, true],
  ] as const)("%s %s (owner=%s) → %s", (role, action, owner, expected) => {
    expect(canActOn(role, action, owner)).toBe(expected);
  });
});

describe("canActOnComment (SPEC §3.2, §8)", () => {
  it.each([
    ["viewer", true, false],
    ["commenter", true, true],
    ["commenter", false, false],
    ["contributor", false, false],
    ["editor", false, true],
    ["none", true, false],
    ["admin", false, true],
  ] as const)("%s (owner=%s) → %s", (role, owner, expected) => {
    expect(canActOnComment(role, owner)).toBe(expected);
  });
});

describe("song lock (SPEC §25.12)", () => {
  const frozen: Capability[] = ["comment", "annotate.own", "annotate.any", "tempo.edit"];
  const open = CAPABILITIES.filter((c) => !frozen.includes(c));

  it.each(frozen)("refuses changes needing %s while locked", (capability) => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(blockedBySongLock(true, { method, capability })).toBe(true);
      expect(blockedBySongLock(false, { method, capability })).toBe(false);
    }
  });

  it.each(frozen)("still reads with %s while locked", (capability) => {
    expect(blockedBySongLock(true, { method: "GET", capability })).toBe(false);
    expect(blockedBySongLock(true, { method: "HEAD", capability })).toBe(false);
  });

  it.each(open)("leaves %s alone without frozen fields", (capability) => {
    expect(blockedBySongLock(true, { method: "POST", capability })).toBe(false);
    expect(lockedOut(true, capability)).toBe(false);
  });

  it("freezes only the named fields of mixed routes", () => {
    const track = (body: unknown) =>
      blockedBySongLock(true, {
        method: "PATCH",
        capability: "edit.own",
        lockFields: DEFAULT_MIX_FIELDS,
        body,
      });
    expect(track({ name: "Bass", color: "red" })).toBe(false);
    expect(track({ defaultGainDb: -3 })).toBe(true);
    expect(track({ name: "Bass", defaultMuted: false })).toBe(true);
    expect(track({ defaultPan: undefined })).toBe(false);
    expect(track(null)).toBe(false);
    const full = (body: unknown) =>
      blockedBySongLock(true, {
        method: "PATCH",
        capability: "edit.own",
        lockFields: TRACK_LOCK_FIELDS,
        body,
      });
    expect(full({ name: "Bass", instrumentTag: "lead" })).toBe(false);
    expect(full({ instrument: null })).toBe(true);
    expect(full({ transpose: false })).toBe(true);
    expect(full({ voiceRange: "low" })).toBe(true);
    expect(full({ defaultPan: 0 })).toBe(true);
    expect(track(undefined)).toBe(false);
    const version = { method: "PATCH", capability: "edit.own" as const };
    expect(
      blockedBySongLock(true, { ...version, lockFields: VERSION_GAIN_FIELDS, body: { gainDb: 0 } }),
    ).toBe(true);
    expect(
      blockedBySongLock(true, {
        ...version,
        lockFields: VERSION_GAIN_FIELDS,
        body: { label: "x" },
      }),
    ).toBe(false);
    expect(
      blockedBySongLock(false, {
        ...version,
        lockFields: VERSION_GAIN_FIELDS,
        body: { gainDb: 1 },
      }),
    ).toBe(false);
  });

  it("disables the frozen controls in the client", () => {
    for (const c of frozen) {
      expect(lockedOut(true, c)).toBe(true);
      expect(lockedOut(false, c)).toBe(false);
    }
  });
});

describe("Trash and batch rights (SPEC §26.3, §26.6)", () => {
  const ROLES = [...CONTENT_ROLES, "admin"] as const;
  /** Written out by hand: [song, own track, other's track, own version, other's version]. */
  const DELETE: Record<EffectiveRole, readonly boolean[]> = {
    none: [false, false, false, false, false],
    viewer: [false, false, false, false, false],
    commenter: [false, false, false, false, false],
    contributor: [false, true, false, true, false],
    editor: [false, true, true, true, true],
    manager: [true, true, true, true, true],
    admin: [true, true, true, true, true],
  };
  const PURGE: Record<EffectiveRole, readonly boolean[]> = {
    none: [false, false, false, false, false],
    viewer: [false, false, false, false, false],
    commenter: [false, false, false, false, false],
    contributor: [false, false, false, true, false],
    editor: [false, false, false, true, false],
    manager: [true, true, true, true, true],
    admin: [true, true, true, true, true],
  };
  const cases = [
    ["song", false],
    ["track", true],
    ["track", false],
    ["version", true],
    ["version", false],
  ] as const;

  it("knows the three kinds", () => {
    expect(TRASH_KINDS).toEqual(["song", "track", "version"]);
  });

  for (const role of ROLES) {
    it(`${role}: delete and restore`, () => {
      expect(cases.map(([k, own]) => canDeleteContent(role, k, own))).toEqual(DELETE[role]);
      expect(cases.map(([k, own]) => canRestoreContent(role, k, own))).toEqual(DELETE[role]);
    });
    it(`${role}: delete permanently`, () => {
      expect(cases.map(([k, own]) => canPurgeContent(role, k, own))).toEqual(PURGE[role]);
    });
  }

  it("projects in the Trash: only admins restore and purge them (SPEC §26.3)", () => {
    for (const role of [...CONTENT_ROLES, "admin"] as const) {
      expect(canRestoreContainer(role, "project", true)).toBe(role === "admin");
      expect(canPurgeContainer(role, "project")).toBe(role === "admin");
    }
  });

  it("documents in the Trash: restore like their delete, purge with trash.purge", () => {
    const want: Record<EffectiveRole, readonly boolean[]> = {
      // [restore own, restore other, purge]
      none: [false, false, false],
      viewer: [false, false, false],
      commenter: [false, false, false],
      contributor: [true, false, false],
      editor: [true, true, false],
      manager: [true, true, true],
      admin: [true, true, true],
    };
    for (const role of [...CONTENT_ROLES, "admin"] as const) {
      expect([
        canRestoreContainer(role, "document", true),
        canRestoreContainer(role, "document", false),
        canPurgeContainer(role, "document"),
      ]).toEqual(want[role]);
    }
  });

  it("remove full quality: managers and admins, else the uploader of their own versions", () => {
    const want: Record<EffectiveRole, readonly boolean[]> = {
      none: [false, false],
      viewer: [false, false],
      commenter: [false, false],
      contributor: [true, false],
      editor: [true, false],
      manager: [true, true],
      admin: [true, true],
    };
    for (const role of ROLES) {
      expect([canRemoveLossless(role, true), canRemoveLossless(role, false)]).toEqual(want[role]);
    }
  });

  it("an owner of a song is not special: songs need song.delete", () => {
    expect(canDeleteContent("editor", "song", true)).toBe(false);
    expect(canPurgeContent("editor", "song", true)).toBe(false);
  });

  it("move needs the delete rights, copy edit.any, a target song.create and upload", () => {
    // [move song, move own track, move other's track, copy, add songs to a target]
    const want: Record<EffectiveRole, readonly boolean[]> = {
      none: [false, false, false, false, false],
      viewer: [false, false, false, false, false],
      commenter: [false, false, false, false, false],
      contributor: [false, true, false, false, false],
      editor: [false, true, true, true, true],
      manager: [true, true, true, true, true],
      admin: [true, true, true, true, true],
    };
    for (const role of ROLES) {
      expect([
        canMoveContent(role, "song", false),
        canMoveContent(role, "track", true),
        canMoveContent(role, "track", false),
        canCopyContent(role),
        canAddSongsTo(role),
      ]).toEqual(want[role]);
    }
  });
});

describe("canBounce (SPEC §5.5)", () => {
  it("needs stream on the song and song.create on the project", () => {
    const all = [...CONTENT_ROLES, "admin"] as const;
    for (const song of all) {
      for (const project of all) {
        const want = !["none"].includes(song) && ["editor", "manager", "admin"].includes(project);
        expect(canBounce(song, project), `${song}/${project}`).toBe(want);
      }
    }
  });
});
