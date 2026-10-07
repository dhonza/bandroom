import * as shared from "@bandroom/shared";
import { ApiErrorSchema, hasGlobalCapability, type ContractDef } from "@bandroom/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, loginAs, seedUser, type TestApp } from "../testing/testApp";

/**
 * Table-driven authorization check (SPEC §20): every registered contract × every kind of caller.
 * Authorization runs before validation, so dummy params/bodies are enough to observe it.
 */
function isContract(v: unknown): v is ContractDef {
  return typeof v === "object" && v !== null && "method" in v && "path" in v && "response" in v;
}
const contracts: [string, ContractDef][] = [];
// Link-visitor contracts live below `/l/:token` and are covered by links.test.ts.
for (const [name, value] of Object.entries(shared) as [string, unknown][]) {
  if (isContract(value) && !shared.LINK_VISITOR_CONTRACTS.includes(value))
    contracts.push([name, value]);
}

type Caller = "anonymous" | "guest" | "member" | "admin";
const CALLERS: Caller[] = ["anonymous", "guest", "member", "admin"];

type Outcome = "allowed" | "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND";

/**
 * Expected outcome for a dummy scope id ("x"). Scoped routes answer NOT_FOUND for unknown ids
 * (existence is not leaked); real project/song scopes are covered by content-permissions.test.ts.
 */
function expected(c: ContractDef, caller: Caller): Outcome {
  const auth = c.auth;
  if (auth && "public" in auth) return "allowed";
  if (caller === "anonymous") return "UNAUTHENTICATED";
  if (auth && "global" in auth) {
    return hasGlobalCapability({ globalRole: caller, disabledAt: null }, auth.global)
      ? "allowed"
      : "FORBIDDEN";
  }
  if (auth && "scope" in auth) return "NOT_FOUND";
  return "allowed";
}

let t: TestApp;
const cookies: Partial<Record<Caller, string>> = {};

beforeAll(async () => {
  t = await createTestApp();
  for (const role of ["guest", "member", "admin"] as const) {
    await seedUser(t, role, role);
    cookies[role] = await loginAs(t, role);
  }
});
afterAll(async () => {
  await t.close();
});

describe("route authorization matrix", () => {
  it("covers every contract", () => {
    expect(contracts.length).toBeGreaterThanOrEqual(20);
  });

  // Session-revoking endpoints are excluded from "allowed" calls so they do not log callers out.
  const destructive = new Set(["logout", "revokeMyOtherSessions", "revokeMySession"]);

  for (const [name, contract] of contracts) {
    for (const caller of CALLERS) {
      const want = expected(contract, caller);
      if (want === "allowed" && destructive.has(name) && caller !== "anonymous") continue;
      it(`${name} as ${caller} → ${want}`, async () => {
        const params = Object.fromEntries(
          [...contract.path.matchAll(/:(\w+)/g)].map((m) => [m[1] ?? "", "x"]),
        );
        const hasBody = contract.method !== "GET" && contract.method !== "DELETE";
        const res = await call(
          t,
          contract,
          { params, ...(hasBody && { body: {} }) },
          cookies[caller],
        );
        const parsed = ApiErrorSchema.safeParse(res.json());
        const gotCode = res.statusCode >= 400 && parsed.success ? parsed.data.code : "allowed";
        if (want === "allowed") {
          expect(["UNAUTHENTICATED", "FORBIDDEN"]).not.toContain(gotCode);
        } else {
          expect(gotCode).toBe(want);
        }
      });
    }
  }
});
