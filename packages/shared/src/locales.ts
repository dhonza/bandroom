import { z } from "zod";

export const LOCALES = ["en", "cs"] as const;
export type Locale = (typeof LOCALES)[number];
export const LocaleSchema = z.enum(LOCALES);
export const DEFAULT_LOCALE: Locale = "en";
