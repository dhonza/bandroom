import { describe, expect, it } from "vitest";
import { openSecret, sealSecret } from "./secretBox";

const SECRET = "test-app-secret-0123456789-abcdefghijklmnop";

describe("secretBox", () => {
  it("round-trips and uses a fresh IV each time", () => {
    const a = sealSecret(SECRET, "samply", "api-key-1");
    const b = sealSecret(SECRET, "samply", "api-key-1");
    expect(a).not.toBe(b);
    expect(a).not.toContain("api-key-1");
    expect(openSecret(SECRET, "samply", a)).toBe("api-key-1");
  });

  it("rejects another secret, another purpose and tampering", () => {
    const sealed = sealSecret(SECRET, "samply", "api-key-1");
    expect(() => openSecret(`${SECRET}x`, "samply", sealed)).toThrow();
    expect(() => openSecret(SECRET, "other", sealed)).toThrow();
    const raw = Buffer.from(sealed, "base64url");
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 1;
    expect(() => openSecret(SECRET, "samply", raw.toString("base64url"))).toThrow();
    expect(() => openSecret(SECRET, "samply", "short")).toThrow();
  });
});
