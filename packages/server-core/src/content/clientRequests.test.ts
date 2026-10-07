import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertUser } from "../auth/users";
import type { Db } from "../db/connection";
import { createTestDb } from "../testing/testDb";
import {
  CLIENT_REQUEST_TTL_MS,
  purgeClientRequests,
  storeClientResponse,
  storedClientResponse,
} from "./clientRequests";

let db: Db;
let close: () => void;
let userId: string;

beforeAll(() => {
  ({ db, close } = createTestDb());
  userId = insertUser(db, {
    username: "petr",
    displayName: "Petr",
    globalRole: "member",
    passwordHash: "x",
  }).id;
});
afterAll(() => {
  close();
});

describe("client request ids (SPEC §18.3)", () => {
  it("returns the stored response for the same user and route, and purges after 7 days", () => {
    const now = 1_000_000_000_000;
    storeClientResponse(db, userId, "r1", "createComment", { comment: { id: "c1" } }, now);
    storeClientResponse(db, userId, "r1", "createComment", { comment: { id: "c2" } }, now);
    expect(storedClientResponse(db, userId, "r1", "createComment")).toEqual({
      comment: { id: "c1" },
    });
    expect(storedClientResponse(db, userId, "r1", "other")).toBeUndefined();
    expect(storedClientResponse(db, userId, "r2", "createComment")).toBeUndefined();
    expect(purgeClientRequests(db, now + CLIENT_REQUEST_TTL_MS - 1)).toBe(0);
    expect(purgeClientRequests(db, now + CLIENT_REQUEST_TTL_MS + 1)).toBe(1);
    expect(storedClientResponse(db, userId, "r1", "createComment")).toBeUndefined();
  });
});
