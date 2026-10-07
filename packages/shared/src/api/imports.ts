import { z } from "zod";
import { ImportMappingSchema, ImportRunSchema, SamplyProjectSummarySchema } from "../imports";
import { OkSchema } from "./auth";
import { defineContract } from "./contract";

/** Samply importer (SPEC §17): admin-only wizard. */
const admin = { global: "admin.access" } as const;
const IdParams = z.object({ id: z.string().min(1).max(64) });

const SamplyApiKeySchema = z.string().trim().min(8).max(512);

/**
 * Step 1: connect with an API key, or with the admin's saved key (SPEC §25.11). The run keeps
 * its own sealed copy of the key until it ends.
 */
export const samplyConnect = defineContract({
  method: "POST",
  path: "/admin/imports/samply",
  body: z.union([
    z.object({ apiKey: SamplyApiKeySchema }),
    z.object({ useSavedKey: z.literal(true) }),
  ]),
  response: z.object({ run: ImportRunSchema, projects: z.array(SamplyProjectSummarySchema) }),
  errors: ["SAMPLY_AUTH_FAILED", "SAMPLY_UNAVAILABLE", "SAMPLY_KEY_NOT_SAVED"],
  auth: admin,
});

/** What an admin sees of their saved Samply key: never the key itself (SPEC §25.11). */
export const SavedSecretSchema = z.object({
  saved: z.boolean(),
  last4: z.string().nullable(),
  updatedAt: z.number().nullable(),
});
export type SavedSecret = z.infer<typeof SavedSecretSchema>;

export const getMySamplyKey = defineContract({
  method: "GET",
  path: "/me/secrets/samply",
  response: SavedSecretSchema,
  auth: admin,
});

/** Saves (or replaces) the current admin's Samply key, sealed; it is never returned. */
export const saveMySamplyKey = defineContract({
  method: "PUT",
  path: "/me/secrets/samply",
  body: z.object({ apiKey: SamplyApiKeySchema }),
  response: SavedSecretSchema,
  auth: admin,
});

export const deleteMySamplyKey = defineContract({
  method: "DELETE",
  path: "/me/secrets/samply",
  response: SavedSecretSchema,
  auth: admin,
});

export const listImportRuns = defineContract({
  method: "GET",
  path: "/admin/imports",
  response: z.object({ runs: z.array(ImportRunSchema) }),
  auth: admin,
});

export const getImportRun = defineContract({
  method: "GET",
  path: "/admin/imports/:id",
  params: IdParams,
  response: z.object({ run: ImportRunSchema }),
  errors: ["NOT_FOUND"],
  auth: admin,
});

/** The owned projects again (e.g. after reopening the wizard). */
export const listImportProjects = defineContract({
  method: "GET",
  path: "/admin/imports/:id/projects",
  params: IdParams,
  response: z.object({ projects: z.array(SamplyProjectSummarySchema) }),
  errors: ["NOT_FOUND", "SAMPLY_AUTH_FAILED", "SAMPLY_UNAVAILABLE", "IMPORT_KEY_GONE"],
  auth: admin,
});

/** Step 2–3: scan the selected projects in the background (box trees, comments, sizes). */
export const scanImport = defineContract({
  method: "POST",
  path: "/admin/imports/:id/scan",
  params: IdParams,
  body: z.object({ projectIds: z.array(z.string().min(1)).min(1).max(100) }),
  response: OkSchema,
  errors: ["NOT_FOUND", "IMPORT_STATE", "IMPORT_KEY_GONE"],
  auth: admin,
});

/** Step 4: save the reviewed mapping. */
export const updateImportMapping = defineContract({
  method: "PUT",
  path: "/admin/imports/:id/mapping",
  params: IdParams,
  body: z.object({ mapping: ImportMappingSchema }),
  response: z.object({ run: ImportRunSchema }),
  errors: ["NOT_FOUND", "IMPORT_STATE", "VALIDATION_FAILED"],
  auth: admin,
});

/** Step 5: run (or dry-run: report only, nothing is written). */
export const startImport = defineContract({
  method: "POST",
  path: "/admin/imports/:id/start",
  params: IdParams,
  body: z.object({ dryRun: z.boolean().default(false) }),
  response: OkSchema,
  errors: ["NOT_FOUND", "IMPORT_STATE", "IMPORT_KEY_GONE", "QUOTA_EXCEEDED", "DISK_FULL"],
  auth: admin,
});

/** Stops a scan/run and forgets the API key. Items already imported stay (resumable). */
export const cancelImport = defineContract({
  method: "POST",
  path: "/admin/imports/:id/cancel",
  params: IdParams,
  response: OkSchema,
  errors: ["NOT_FOUND"],
  auth: admin,
});
