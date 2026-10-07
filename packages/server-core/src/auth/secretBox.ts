import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for short secrets kept at rest (e.g. an import run's API key, SPEC §17.1). The key
 * is derived from the app secret per purpose, so rotating APP_SECRET invalidates stored secrets.
 * Format: base64url(iv[12] | tag[16] | ciphertext).
 */
function keyFor(appSecret: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", appSecret, "bandroom.secretbox", purpose, 32));
}

export function sealSecret(appSecret: string, purpose: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(appSecret, purpose), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64url");
}

/** Throws if the data was tampered with or sealed with another secret/purpose. */
export function openSecret(appSecret: string, purpose: string, sealed: string): string {
  const raw = Buffer.from(sealed, "base64url");
  if (raw.length < 29) throw new Error("sealed secret too short");
  const decipher = createDecipheriv("aes-256-gcm", keyFor(appSecret, purpose), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}
