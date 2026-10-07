import { describe, expect, it } from "vitest";
import { GLOBAL_CAPABILITIES, GLOBAL_ROLES, hasGlobalCapability, type GlobalRole } from "./global";

const expected: Record<GlobalRole, Record<string, boolean>> = {
  admin: { "admin.access": true, "project.create": true, "users.directory": true },
  member: { "admin.access": false, "project.create": true, "users.directory": true },
  guest: { "admin.access": false, "project.create": false, "users.directory": false },
};

describe("hasGlobalCapability", () => {
  for (const role of GLOBAL_ROLES) {
    for (const cap of GLOBAL_CAPABILITIES) {
      it(`${role} → ${cap} = ${String(expected[role][cap])}`, () => {
        expect(hasGlobalCapability({ globalRole: role, disabledAt: null }, cap)).toBe(
          expected[role][cap],
        );
      });
    }
  }

  it("denies anonymous and disabled users", () => {
    expect(hasGlobalCapability(null, "project.create")).toBe(false);
    expect(hasGlobalCapability({ globalRole: "admin", disabledAt: 1 }, "admin.access")).toBe(false);
  });
});
