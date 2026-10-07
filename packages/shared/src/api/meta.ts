import { z } from "zod";
import { LocaleSchema } from "../locales";
import { defineContract } from "./contract";

export const MetaSchema = z.object({
  instanceName: z.string(),
  version: z.string(),
  locales: z.array(LocaleSchema),
  defaultLocale: LocaleSchema,
  /** Branding logo (SPEC §25.1); load it from `brandingLogoPath(logoHash)`. */
  logoHash: z.string().nullable(),
});

export const getMeta = defineContract({
  method: "GET",
  path: "/meta",
  response: MetaSchema,
  auth: { public: true },
});
