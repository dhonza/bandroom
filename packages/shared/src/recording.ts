import { z } from "zod";

/** Default of the `recording.maxTakeMinutes` instance setting (SPEC §9). */
export const DEFAULT_MAX_TAKE_MINUTES = 180;
/** Allowed range of the max take length in minutes: 1 min to 10 h. */
export const MaxTakeMinutesSchema = z.number().int().min(1).max(600);
