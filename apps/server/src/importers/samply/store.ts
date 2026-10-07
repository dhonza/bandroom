import { schema, type Db } from "@bandroom/server-core";
import {
  ImportMappingSchema,
  ImportReportSchema,
  uuidv7,
  type ImportMapping,
  type ImportReport,
  type ImportRun,
  type ImportRunStatus,
} from "@bandroom/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { computeTotals } from "./mapping";

const { importRuns, importMap } = schema;
export type ImportRunRow = typeof importRuns.$inferSelect;

/** Purpose string for {@link sealSecret} (per-purpose key derivation). */
export const SAMPLY_SECRET_PURPOSE = "import.samply.apiKey";

export function createRun(
  db: Db,
  input: { secretEnc: string; createdBy: string },
  now = Date.now(),
): ImportRunRow {
  return db
    .insert(importRuns)
    .values({
      id: uuidv7(now),
      source: "samply",
      status: "connected",
      secretEnc: input.secretEnc,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

export function getRun(db: Db, id: string): ImportRunRow | undefined {
  return db.select().from(importRuns).where(eq(importRuns.id, id)).get();
}

export function listRuns(db: Db, limit = 50): ImportRunRow[] {
  return db.select().from(importRuns).orderBy(desc(importRuns.createdAt)).limit(limit).all();
}

export interface RunPatch {
  status?: ImportRunStatus;
  dryRun?: boolean;
  secretEnc?: string | null;
  selection?: string[];
  mapping?: ImportMapping | null;
  report?: ImportReport | null;
  progress?: number;
  error?: string | null;
  finishedAt?: number | null;
}

export function updateRun(db: Db, id: string, patch: RunPatch, now = Date.now()): ImportRunRow {
  const { selection, mapping, report, ...rest } = patch;
  return db
    .update(importRuns)
    .set({
      ...rest,
      ...(selection !== undefined ? { selection: JSON.stringify(selection) } : {}),
      ...(mapping !== undefined ? { mapping: mapping && JSON.stringify(mapping) } : {}),
      ...(report !== undefined ? { report: report && JSON.stringify(report) } : {}),
      updatedAt: now,
    })
    .where(eq(importRuns.id, id))
    .returning()
    .get();
}

const parseJson = <T>(s: string | null, schemaOf: z.ZodType<T>): T | null => {
  if (!s) return null;
  const r = schemaOf.safeParse(JSON.parse(s));
  return r.success ? r.data : null;
};

export function runMapping(row: ImportRunRow): ImportMapping | null {
  return parseJson(row.mapping, ImportMappingSchema);
}

export function toImportRun(row: ImportRunRow): ImportRun {
  const mapping = runMapping(row);
  return {
    id: row.id,
    source: "samply",
    status: row.status,
    dryRun: row.dryRun,
    progress: row.progress,
    error: row.error,
    selection: parseJson(row.selection, z.array(z.string())) ?? [],
    mapping,
    totals: mapping ? computeTotals(mapping) : null,
    report: parseJson(row.report, ImportReportSchema),
    hasKey: row.secretEnc !== null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt,
  };
}

// --- import_map ---------------------------------------------------------------------------------

export type ExternalType = "project" | "box" | "file" | "comment" | "insight";
export type LocalType =
  "project" | "song" | "track" | "trackVersion" | "document" | "comment" | "event";

export function lookupLocal(
  db: Db,
  externalType: ExternalType,
  externalId: string,
  localType: LocalType,
): string | null {
  return (
    db
      .select({ id: importMap.localId })
      .from(importMap)
      .where(
        and(
          eq(importMap.source, "samply"),
          eq(importMap.externalType, externalType),
          eq(importMap.externalId, externalId),
          eq(importMap.localType, localType),
        ),
      )
      .get()?.id ?? null
  );
}

/**
 * Whether a local entity from an earlier run still exists: it and everything it lives in (a
 * version's track, song and project) are not deleted. Deleting a project in BandRoom marks only
 * the project, so its songs/tracks/versions must be judged through the chain.
 */
const ALIVE_SQL: Record<LocalType, string> = {
  project: "SELECT 1 FROM projects p WHERE p.id = ? AND p.deleted_at IS NULL",
  song: `SELECT 1 FROM songs s JOIN projects p ON p.id = s.project_id
         WHERE s.id = ? AND s.deleted_at IS NULL AND p.deleted_at IS NULL`,
  track: `SELECT 1 FROM tracks t JOIN songs s ON s.id = t.song_id JOIN projects p ON p.id = s.project_id
          WHERE t.id = ? AND t.deleted_at IS NULL AND s.deleted_at IS NULL AND p.deleted_at IS NULL`,
  trackVersion: `SELECT 1 FROM track_versions v JOIN tracks t ON t.id = v.track_id
          JOIN songs s ON s.id = t.song_id JOIN projects p ON p.id = s.project_id
          WHERE v.id = ? AND v.deleted_at IS NULL AND t.deleted_at IS NULL
            AND s.deleted_at IS NULL AND p.deleted_at IS NULL`,
  document: `SELECT 1 FROM documents d JOIN projects p ON p.id = d.project_id
          LEFT JOIN songs s ON s.id = d.song_id
          WHERE d.id = ? AND d.deleted_at IS NULL AND p.deleted_at IS NULL
            AND (d.song_id IS NULL OR s.deleted_at IS NULL)`,
  comment: `SELECT 1 FROM comments c JOIN songs s ON s.id = c.song_id JOIN projects p ON p.id = s.project_id
          WHERE c.id = ? AND c.deleted_at IS NULL AND s.deleted_at IS NULL AND p.deleted_at IS NULL`,
  event: `SELECT 1 FROM events e LEFT JOIN projects p ON p.id = e.project_id
          WHERE e.id = ? AND (e.project_id IS NULL OR p.deleted_at IS NULL)`,
};

export function isAlive(db: Db, localType: LocalType, localId: string): boolean {
  return db.$client.prepare(ALIVE_SQL[localType]).get(localId) !== undefined;
}

/** The local entity an earlier run created for this external item, if it still exists. */
export function liveLocal(
  db: Db,
  externalType: ExternalType,
  externalId: string,
  localType: LocalType,
): string | null {
  const id = lookupLocal(db, externalType, externalId, localType);
  return id && isAlive(db, localType, id) ? id : null;
}

/**
 * Like {@link liveLocal}, plus whether `runId` itself made it: a retried attempt of a run finds
 * what its failed attempt imported, and must report that as imported, not as existing.
 */
export function liveLocalOfRun(
  db: Db,
  externalType: ExternalType,
  externalId: string,
  localType: LocalType,
  runId: string,
): { id: string; thisRun: boolean } | null {
  const row = db
    .select({ id: importMap.localId, runId: importMap.runId })
    .from(importMap)
    .where(
      and(
        eq(importMap.source, "samply"),
        eq(importMap.externalType, externalType),
        eq(importMap.externalId, externalId),
        eq(importMap.localType, localType),
      ),
    )
    .get();
  return row && isAlive(db, localType, row.id)
    ? { id: row.id, thisRun: row.runId === runId }
    : null;
}

/** Samply files whose imported version or document still exists (deleted ones re-import). */
export function liveImportedFiles(db: Db, fileIds: readonly string[]): Set<string> {
  const candidates = importedIds(db, "file", fileIds);
  return new Set(
    [...candidates].filter(
      (id) => liveLocal(db, "file", id, "trackVersion") ?? liveLocal(db, "file", id, "document"),
    ),
  );
}

/** The external id an earlier run mapped to this local entity (e.g. which box made a song). */
export function lookupExternal(
  db: Db,
  localType: LocalType,
  localId: string,
  externalType: ExternalType,
): string | null {
  return (
    db
      .select({ id: importMap.externalId })
      .from(importMap)
      .where(
        and(
          eq(importMap.source, "samply"),
          eq(importMap.localType, localType),
          eq(importMap.localId, localId),
          eq(importMap.externalType, externalType),
        ),
      )
      .get()?.id ?? null
  );
}

/** Which of these external ids were already imported (any local type). */
export function importedIds(
  db: Db,
  externalType: ExternalType,
  externalIds: readonly string[],
): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < externalIds.length; i += 500) {
    const chunk = externalIds.slice(i, i + 500);
    for (const r of db
      .select({ id: importMap.externalId })
      .from(importMap)
      .where(
        and(
          eq(importMap.source, "samply"),
          eq(importMap.externalType, externalType),
          inArray(importMap.externalId, chunk),
        ),
      )
      .all())
      out.add(r.id);
  }
  return out;
}

export function recordMapping(
  db: Db,
  input: {
    externalType: ExternalType;
    externalId: string;
    localType: LocalType;
    localId: string;
    runId: string;
  },
  now = Date.now(),
): void {
  db.insert(importMap)
    .values({ source: "samply", ...input, createdAt: now })
    .onConflictDoUpdate({
      target: [importMap.source, importMap.externalType, importMap.externalId, importMap.localType],
      set: { localId: input.localId, runId: input.runId, createdAt: now },
    })
    .run();
}

/** Scans and imports in progress, for the admins' processing popover (SPEC §25.3). */
export function activeRuns(db: Db): ImportRunRow[] {
  return db
    .select()
    .from(importRuns)
    .where(inArray(importRuns.status, ["scanning", "running"]))
    .orderBy(desc(importRuns.createdAt))
    .all();
}
