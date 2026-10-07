import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/connection";
import { users, userSecrets } from "../db/schema";
import { createTestDb } from "../testing/testDb";
import { openSecret } from "./secretBox";
import { insertUser } from "./users";
import {
  deleteUserSecret,
  getUserSecretInfo,
  openUserSecret,
  saveUserSecret,
  secretLast4,
  userSecretPurpose,
} from "./userSecrets";

const SECRET = "test-app-secret-0123456789-abcdefghijklmnop";
let db: Db;
let close: () => void;
let userId: string;

beforeEach(() => {
  ({ db, close } = createTestDb());
  userId = insertUser(db, {
    username: "admin",
    displayName: "Admin",
    globalRole: "admin",
    passwordHash: "x",
  }).id;
});
afterEach(() => {
  close();
});

describe("user secrets (SPEC §25.11)", () => {
  it("seals, shows only the last four characters and opens again", () => {
    expect(getUserSecretInfo(db, userId, "samply")).toBeNull();
    expect(openUserSecret(db, SECRET, userId, "samply")).toBeNull();
    const info = saveUserSecret(db, SECRET, userId, "samply", "abcdefgh-1234", 1000);
    expect(info).toEqual({ last4: "1234", updatedAt: 1000 });
    const row = db.select().from(userSecrets).get();
    expect(row?.secretEnc).not.toContain("abcdefgh");
    expect(openSecret(SECRET, userSecretPurpose("samply"), row?.secretEnc ?? "")).toBe(
      "abcdefgh-1234",
    );
    expect(openUserSecret(db, SECRET, userId, "samply")).toBe("abcdefgh-1234");
  });

  it("replaces the saved secret and keeps its creation time", () => {
    saveUserSecret(db, SECRET, userId, "samply", "first-key-1111", 1000);
    saveUserSecret(db, SECRET, userId, "samply", "second-key-2222", 2000);
    const rows = db.select().from(userSecrets).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ last4: "2222", createdAt: 1000, updatedAt: 2000 });
    expect(openUserSecret(db, SECRET, userId, "samply")).toBe("second-key-2222");
  });

  it("deletes, and drops a secret sealed under another app secret", () => {
    saveUserSecret(db, SECRET, userId, "samply", "some-key-9999");
    expect(openUserSecret(db, `${SECRET}-rotated`, userId, "samply")).toBeNull();
    expect(getUserSecretInfo(db, userId, "samply")).toBeNull();
    saveUserSecret(db, SECRET, userId, "samply", "some-key-9999");
    expect(deleteUserSecret(db, userId, "samply")).toBe(true);
    expect(deleteUserSecret(db, userId, "samply")).toBe(false);
  });

  it("goes with the user (cascade)", () => {
    saveUserSecret(db, SECRET, userId, "samply", "some-key-9999");
    db.delete(users).where(eq(users.id, userId)).run();
    expect(db.select().from(userSecrets).all()).toHaveLength(0);
  });

  it("hides the tail of short secrets", () => {
    expect(secretLast4("1234567")).toBe("");
    expect(secretLast4("12345678")).toBe("5678");
  });
});
