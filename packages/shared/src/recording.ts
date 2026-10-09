import { z } from "zod";

/** Default of the `recording.maxTakeMinutes` instance setting (SPEC §9). */
export const DEFAULT_MAX_TAKE_MINUTES = 180;
/** Allowed range of the max take length in minutes: 1 min to 10 h. */
export const MaxTakeMinutesSchema = z.number().int().min(1).max(600);

/** Default of the `recording.peakTargetDb` instance setting: where auto level puts a take's peak. */
export const DEFAULT_PEAK_TARGET_DB = -6;
/** Allowed range of the auto-level peak target in dBFS. */
export const PeakTargetDbSchema = z.number().min(-24).max(0);
/** Allowed range of a version gain set at upload (auto level of a recorded take). */
export const UploadGainDbSchema = z.number().min(-60).max(60);
