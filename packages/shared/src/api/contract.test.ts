import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { buildPath, defineContract, type ContractInput, type ContractResponse } from "./contract";
import { getMeta } from "./meta";

describe("buildPath", () => {
  it("substitutes and encodes params", () => {
    expect(buildPath("/songs/:id/tracks/:trackId", { id: "a b", trackId: 3 })).toBe(
      "/songs/a%20b/tracks/3",
    );
  });

  it("leaves paths without params untouched", () => {
    expect(buildPath("/meta")).toBe("/meta");
  });

  it("throws on a missing param", () => {
    expect(() => buildPath("/songs/:id", {})).toThrow(/Missing path param "id"/);
  });
});

describe("contract types", () => {
  it("infers input and response types", () => {
    const _contract = defineContract({
      method: "POST",
      path: "/songs/:id",
      params: z.object({ id: z.string() }),
      body: z.object({ title: z.string() }),
      response: z.object({ ok: z.boolean() }),
    });
    expectTypeOf<ContractInput<typeof _contract>>().toEqualTypeOf<
      { params: { id: string } } & { query?: never } & { body: { title: string } }
    >();
    expectTypeOf<ContractResponse<typeof _contract>>().toEqualTypeOf<{ ok: boolean }>();
  });

  it("meta contract is public GET", () => {
    expect(getMeta.method).toBe("GET");
    expect(getMeta.auth.public).toBe(true);
  });
});
