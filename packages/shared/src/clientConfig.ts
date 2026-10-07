import { z } from "zod";
import { LocaleSchema } from "./locales";

/**
 * Runtime configuration the server injects into `index.html` as
 * `<meta name="bandroom-config" content="…json…">` (no inline script, CSP-safe).
 */
export const CLIENT_CONFIG_META_NAME = "bandroom-config";

export const ClientConfigSchema = z.object({
  appName: z.string(),
  version: z.string(),
  basePath: z.string(),
  defaultLocale: LocaleSchema,
  /** Hash of the branding logo (SPEC §25.1), served publicly by {@link brandingLogoPath}. */
  logoHash: z.string().nullable().default(null),
});

export type ClientConfig = z.infer<typeof ClientConfigSchema>;
