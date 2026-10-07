import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Opaque 256-bit token for cookies and one-time links (base64url, 43 chars). */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Tokens are stored only as SHA-256 hashes (hex). */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time string equality for secrets (the length itself is not secret). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
