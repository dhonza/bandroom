import * as shared from "@bandroom/shared";
import {
  ApiErrorSchema,
  hasGlobalCapability,
  keyMayCall,
  type ApiScope,
  type ContractDef,
  type GlobalRole,
} from "@bandroom/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  call,
  callWithKey,
  createTestApp,
  keyFor,
  loginAs,
  seedUser,
  type TestApp,
} from "../testing/testApp";

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

type Caller =
  | "anonymous"
  | "guest"
  | "member"
  | "admin"
  | "member key read-only"
  | "member key write"
  | "admin key admin:read";
const CALLERS: Caller[] = [
  "anonymous",
  "guest",
  "member",
  "admin",
  "member key read-only",
  "member key write",
  "admin key admin:read",
];

/** API-key callers (SPEC §29.2): the key's user and scopes. */
const KEY_CALLERS: Partial<Record<Caller, { role: GlobalRole; scopes: ApiScope[] }>> = {
  "member key read-only": { role: "member", scopes: ["read"] },
  "member key write": { role: "member", scopes: ["read", "write"] },
  "admin key admin:read": { role: "admin", scopes: ["admin:read"] },
};

type Outcome = "allowed" | "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND" | "API_KEY_SCOPE";

/**
 * Expected outcome for a dummy scope id ("x"). Scoped routes answer NOT_FOUND for unknown ids
 * (existence is not leaked); real project/song scopes are covered by content-permissions.test.ts.
 */
function expected(c: ContractDef, caller: Caller): Outcome {
  const auth = c.auth;
  const key = KEY_CALLERS[caller];
  if (key && !keyMayCall(key.scopes, c)) return "API_KEY_SCOPE";
  if (auth && "public" in auth) return "allowed";
  if (caller === "anonymous") return "UNAUTHENTICATED";
  const role: GlobalRole = key ? key.role : (caller as GlobalRole);
  if (auth && "global" in auth) {
    return hasGlobalCapability({ globalRole: role, disabledAt: null }, auth.global)
      ? "allowed"
      : "FORBIDDEN";
  }
  if (auth && "scope" in auth) return "NOT_FOUND";
  return "allowed";
}

let t: TestApp;
const cookies: Partial<Record<Caller, string>> = {};
const tokens: Partial<Record<Caller, string>> = {};

beforeAll(async () => {
  t = await createTestApp();
  const ids: Partial<Record<GlobalRole, string>> = {};
  for (const role of ["guest", "member", "admin"] as const) {
    ids[role] = (await seedUser(t, role, role)).id;
    cookies[role] = await loginAs(t, role);
  }
  for (const [caller, key] of Object.entries(KEY_CALLERS) as [Caller, typeof KEY_CALLERS.admin][]) {
    if (key) tokens[caller] = keyFor(t, ids[key.role] ?? "", key.scopes);
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
        const input = { params, ...(hasBody && { body: {} }) };
        const token = tokens[caller];
        const res = token
          ? await callWithKey(t, contract, input, token)
          : await call(t, contract, input, cookies[caller]);
        const parsed = ApiErrorSchema.safeParse(res.json());
        const gotCode = res.statusCode >= 400 && parsed.success ? parsed.data.code : "allowed";
        if (want === "allowed") {
          expect([
            "UNAUTHENTICATED",
            "FORBIDDEN",
            "API_KEY_SCOPE",
            "API_KEY_INVALID",
          ]).not.toContain(gotCode);
        } else {
          expect(gotCode).toBe(want);
        }
      });
    }
  }
});
