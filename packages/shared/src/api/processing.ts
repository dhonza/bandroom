import { z } from "zod";
import { ProcessingSchema } from "../content";
import { ImportRunStatusSchema } from "../imports";
import { defineContract } from "./contract";

/** A song with media work, for the header's processing popover (SPEC §25.3). */
export const ProcessingSongSchema = z.object({
  songId: z.string(),
  title: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  processing: ProcessingSchema,
});
export type ProcessingSong = z.infer<typeof ProcessingSongSchema>;

/** A running Samply scan or import (admins only). */
export const ImportRunProgressSchema = z.object({
  id: z.string(),
  status: ImportRunStatusSchema,
  dryRun: z.boolean(),
  progress: z.number(),
});
export type ImportRunProgress = z.infer<typeof ImportRunProgressSchema>;

/**
 * Songs with work in progress or failures that the user can see, and (admins) running imports
 * (SPEC §25.3).
 */
export const getProcessing = defineContract({
  method: "GET",
  path: "/processing",
  response: z.object({
    songs: z.array(ProcessingSongSchema),
    imports: z.array(ImportRunProgressSchema),
  }),
  auth: { user: true },
});
