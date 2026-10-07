import { and, eq } from "drizzle-orm";
import type { Db } from "../db/connection";
import { userSecrets } from "../db/schema";
import { openSecret, sealSecret } from "./secretBox";

export type UserSecretKind = (typeof userSecrets.$inferSelect)["kind"];

/** What may be shown about a saved secret: never the secret itself (SPEC §25.11). */
export interface UserSecretInfo {
  last4: string;
  updatedAt: number;
}

/** Sealing purpose per kind, so a secret of one kind never opens as another. */
export function userSecretPurpose(kind: UserSecretKind): string {
  return `user-secret.${kind}`;
}

/** The last four characters shown as "••••1234" (fewer when the secret is shorter than 8). */
export function secretLast4(secret: string): string {
  return secret.length >= 8 ? secret.slice(-4) : "";
}

/** Saves (or replaces) the user's secret of this kind, sealed under the app secret. */
export function saveUserSecret(
  db: Db,
  appSecret: string,
  userId: string,
  kind: UserSecretKind,
  secret: string,
  now: number = Date.now(),
): UserSecretInfo {
  const values = {
    secretEnc: sealSecret(appSecret, userSecretPurpose(kind), secret),
    last4: secretLast4(secret),
    updatedAt: now,
  };
  db.insert(userSecrets)
    .values({ userId, kind, createdAt: now, ...values })
    .onConflictDoUpdate({ target: [userSecrets.userId, userSecrets.kind], set: values })
    .run();
  return { last4: values.last4, updatedAt: now };
}

export function getUserSecretInfo(
  db: Db,
  userId: string,
  kind: UserSecretKind,
): UserSecretInfo | null {
  return (
    db
      .select({ last4: userSecrets.last4, updatedAt: userSecrets.updatedAt })
      .from(userSecrets)
      .where(and(eq(userSecrets.userId, userId), eq(userSecrets.kind, kind)))
      .get() ?? null
  );
}

/**
 * The plaintext secret, or null when none is saved or it no longer opens (e.g. APP_SECRET was
 * rotated); a secret that cannot be opened is useless and is deleted.
 */
export function openUserSecret(
  db: Db,
  appSecret: string,
  userId: string,
  kind: UserSecretKind,
): string | null {
  const row = db
    .select({ secretEnc: userSecrets.secretEnc })
    .from(userSecrets)
    .where(and(eq(userSecrets.userId, userId), eq(userSecrets.kind, kind)))
    .get();
  if (!row) return null;
  try {
    return openSecret(appSecret, userSecretPurpose(kind), row.secretEnc);
  } catch {
    deleteUserSecret(db, userId, kind);
    return null;
  }
}

/** Deletes the secret; true when one existed. */
export function deleteUserSecret(db: Db, userId: string, kind: UserSecretKind): boolean {
  const res = db
    .delete(userSecrets)
    .where(and(eq(userSecrets.userId, userId), eq(userSecrets.kind, kind)))
    .run();
  return res.changes > 0;
}
