import { ContentRoleSchema, LocaleSchema } from "@bandroom/shared";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/connection";
import { settings } from "../db/schema";

/**
 * Registry of instance settings (SPEC §4.1): each key has a Zod schema and a default.
 * Keys are added in the milestone that first needs them.
 */
export const SETTINGS = {
  /** Overrides `APP_NAME` when set by an admin. */
  instanceName: { schema: z.string().min(1).max(80).nullable(), default: null },
  defaultLocale: { schema: LocaleSchema.nullable(), default: null },
  /** Role every member has on every project unless a grant says otherwise (SPEC §3.2). */
  "defaultProjectRole.member": { schema: ContentRoleSchema, default: "contributor" },
  "defaultProjectRole.guest": { schema: ContentRoleSchema, default: "none" },
  /** Keep uploaded lossless originals after the FLAC is verified (SPEC §5.3 step 4). */
  keepOriginalLossless: { schema: z.boolean(), default: false },
  /** Opus bitrates in kbps (SPEC §5.3 step 5; tune after listening tests, §23.2). */
  "audio.opusBitrates": {
    schema: z.object({
      mixStereo: z.number(),
      mixMono: z.number(),
      trackStereo: z.number(),
      trackMono: z.number(),
      lowStereo: z.number(),
      lowMono: z.number(),
    }),
    default: {
      mixStereo: 128,
      mixMono: 64,
      trackStereo: 96,
      trackMono: 64,
      lowStereo: 48,
      lowMono: 32,
    },
  },
  /** Date (YYYY-MM-DD, server time) of the last daily maintenance run (SPEC §18.4). */
  "maintenance.lastRun": { schema: z.string().nullable(), default: null },
  /** Asset of the branding logo in use (SPEC §25.1). */
  "branding.logoAssetId": { schema: z.string().nullable(), default: null },
  /** A logo upload still being processed (or rejected); it replaces the logo once ready. */
  "branding.logoPendingAssetId": { schema: z.string().nullable(), default: null },
  /** Days a deleted song, track or version stays in the Trash before it is purged (SPEC §26.3). */
  "trash.retentionDays": { schema: z.number().int().min(1).max(3650), default: 30 },
  /** Instance default per-user quota (SPEC §15.1), 5 GB. */
  defaultQuotaBytes: { schema: z.number().int().min(0), default: 5 * 1024 ** 3 },
} as const satisfies Record<string, { schema: z.ZodType; default: unknown }>;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.output<(typeof SETTINGS)[K]["schema"]>;

export function getSetting<K extends SettingKey>(db: Db, key: K): SettingValue<K> {
  const def = SETTINGS[key];
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  if (row === undefined) return def.default as SettingValue<K>;
  let raw: unknown;
  try {
    raw = JSON.parse(row.value);
  } catch {
    return def.default as SettingValue<K>;
  }
  const parsed = def.schema.safeParse(raw);
  // A stored value that no longer validates falls back to the default instead of crashing.
  return (parsed.success ? parsed.data : def.default) as SettingValue<K>;
}

export function setSetting<K extends SettingKey>(
  db: Db,
  key: K,
  value: SettingValue<K>,
  now: number = Date.now(),
): void {
  const json = JSON.stringify(SETTINGS[key].schema.parse(value));
  db.insert(settings)
    .values({ key, value: json, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value: json, updatedAt: now } })
    .run();
}
