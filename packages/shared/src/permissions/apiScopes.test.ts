import { describe, expect, it } from "vitest";
import {
  API_SCOPES,
  hasScope,
  keyMayCall,
  requiredScope,
  scopesAllowedFor,
  type ApiScope,
} from "./apiScopes";

const admin = { global: "admin.access" } as const;

describe("requiredScope", () => {
  it("maps reads and writes of ordinary routes", () => {
    expect(requiredScope({ method: "GET" })).toBe("read");
    expect(requiredScope({ method: "HEAD", auth: { user: true } })).toBe("read");
    expect(requiredScope({ method: "OPTIONS" })).toBe("read");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      expect(requiredScope({ method, auth: { capability: "edit.any", scope: "song" } })).toBe(
        "write",
      );
    }
  });

  it("maps admin routes to admin scopes", () => {
    expect(requiredScope({ method: "GET", auth: admin })).toBe("admin:read");
    expect(requiredScope({ method: "POST", auth: admin })).toBe("admin:ops");
    expect(requiredScope({ method: "DELETE", auth: admin })).toBe("admin:ops");
    // Other global capabilities are ordinary content access.
    expect(requiredScope({ method: "POST", auth: { global: "project.create" } })).toBe("write");
  });

  it("honours overrides", () => {
    expect(requiredScope({ method: "GET", auth: admin, apiKey: false })).toBeNull();
    expect(requiredScope({ method: "POST", apiKey: "read" })).toBe("read");
    expect(requiredScope({ method: "GET", auth: { public: true } })).toBe("read");
  });
});

describe("hasScope", () => {
  it("applies the implications", () => {
    expect(hasScope(["write"], "read")).toBe(true);
    expect(hasScope(["admin:ops"], "admin:read")).toBe(true);
    expect(hasScope(["read"], "write")).toBe(false);
    expect(hasScope(["admin:read"], "admin:ops")).toBe(false);
    expect(hasScope(["admin:ops"], "read")).toBe(false);
    expect(hasScope([], "read")).toBe(false);
    for (const s of API_SCOPES) expect(hasScope([s], s)).toBe(true);
  });
});

describe("keyMayCall", () => {
  it("combines mapping and scopes", () => {
    const read: ApiScope[] = ["read"];
    expect(keyMayCall(read, { method: "GET" })).toBe(true);
    expect(keyMayCall(read, { method: "POST" })).toBe(false);
    expect(keyMayCall(["write"], { method: "POST", apiKey: false })).toBe(false);
    expect(keyMayCall(["read", "write"], { method: "GET", auth: admin })).toBe(false);
    expect(keyMayCall(["admin:read"], { method: "GET", auth: admin })).toBe(true);
  });
});

describe("scopesAllowedFor", () => {
  it("keeps admin scopes for admins", () => {
    expect(scopesAllowedFor("admin", ["admin:ops"])).toBe(true);
    expect(scopesAllowedFor("member", ["read", "write"])).toBe(true);
    expect(scopesAllowedFor("member", ["read", "admin:read"])).toBe(false);
    expect(scopesAllowedFor("guest", ["admin:ops"])).toBe(false);
  });
});
