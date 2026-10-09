import { z } from "zod";
import { LocaleSchema } from "../locales";
import {
  DEFAULT_MAX_TAKE_MINUTES,
  DEFAULT_PEAK_TARGET_DB,
  MaxTakeMinutesSchema,
  PeakTargetDbSchema,
} from "../recording";
import { defineContract } from "./contract";

export const MetaSchema = z.object({
  instanceName: z.string(),
  version: z.string(),
  locales: z.array(LocaleSchema),
  defaultLocale: LocaleSchema,
  /** Branding logo (SPEC §25.1); load it from `brandingLogoPath(logoHash)`. */
  logoHash: z.string().nullable(),
  /**
   * Longest browser recording in minutes (SPEC §9, admin setting `recording.maxTakeMinutes`).
   * Defaulted so a response cached offline by an older version still parses.
   */
  recordingMaxTakeMinutes: MaxTakeMinutesSchema.default(DEFAULT_MAX_TAKE_MINUTES),
  /** Auto-level peak target of recorded takes in dBFS (admin setting `recording.peakTargetDb`). */
  recordingPeakTargetDb: PeakTargetDbSchema.default(DEFAULT_PEAK_TARGET_DB),
});

export const getMeta = defineContract({
  method: "GET",
  path: "/meta",
  response: MetaSchema,
  auth: { public: true },
});
