import {
  parseCommentContext,
  remapComments,
  remapMarkers,
  remapTempoMap,
  uuidv7,
  type CommentContext,
  type CommentRemap,
  type EditRemapSummary,
  type MarkerRemap,
  type RemapStep,
  type Tempo,
} from "@bandroom/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/connection";
import { comments, markers, tempoMapRevisions, tempoMaps } from "../db/schema";
import type { MarkerRow } from "./markers";
import { songTempo } from "./tempo";

/**
 * The timeline follow-up of an applied edit (SPEC §24.4): markers, sections, comments and the
 * tempo map mapped with the session's remap steps (the same pure functions the editor previews
 * with). The review shows its summary; Apply and Bounce to versions write it.
 */

interface CommentItem {
  id: string;
  startSec: number | null;
  endSec: number | null;
  context: CommentContext;
}

export interface RemapPreview {
  markers: MarkerRemap<MarkerRow>;
  comments: CommentRemap<CommentItem>;
  tempoBefore: Tempo | null;
  tempoAfter: Tempo | null;
  tempoChanged: boolean;
  summary: EditRemapSummary;
}

/** The song's live markers and sections (rows). */
export function liveMarkerRows(db: Db, songId: string): MarkerRow[] {
  return db
    .select()
    .from(markers)
    .where(and(eq(markers.songId, songId), isNull(markers.deletedAt)))
    .all();
}

export function remapPreview(
  db: Db,
  songId: string,
  steps: readonly RemapStep[],
  sessionId: string,
): RemapPreview {
  const t = songTempo(db, songId);
  const tempoBefore: Tempo | null = t ? { map: t.map, bar1OffsetSec: t.bar1OffsetSec } : null;
  const items = liveMarkerRows(db, songId);
  const markerRemap = remapMarkers(items, steps, tempoBefore);
  const commentRows = db
    .select({
      id: comments.id,
      startSec: comments.startSec,
      endSec: comments.endSec,
      context: comments.context,
    })
    .from(comments)
    .where(eq(comments.songId, songId))
    .all()
    .map((c) => ({ ...c, context: parseCommentContext(c.context) }));
  const commentRemap = remapComments(commentRows, steps, sessionId);
  const tempoAfter = remapTempoMap(tempoBefore, steps);
  const tempoChanged = JSON.stringify(tempoAfter) !== JSON.stringify(tempoBefore);
  const typeOf = new Map(items.map((m) => [m.id, m.type]));
  const count = (ids: readonly string[], type: "marker" | "section") =>
    ids.filter((id) => typeOf.get(id) === type).length;
  return {
    markers: markerRemap,
    comments: commentRemap,
    tempoBefore,
    tempoAfter,
    tempoChanged,
    summary: {
      markersMoved: count(markerRemap.moved, "marker"),
      markersDeleted: count(markerRemap.deleted, "marker"),
      sectionsMoved: count(markerRemap.moved, "section"),
      sectionsDeleted: count(markerRemap.deleted, "section"),
      commentsMoved: commentRemap.moved.length,
      commentsEditedOut: commentRemap.editedOut.length,
      tempoChanged,
      tempoSegmentsBefore: tempoBefore?.map.segments.length ?? null,
      tempoSegmentsAfter: tempoAfter?.map.segments.length ?? null,
    },
  };
}

/** Stores a tempo map as a new revision and makes it current (no marker moves, no rev bump). */
export function writeTempoRevision(
  db: Db,
  songId: string,
  tempo: Tempo,
  input: { source: "midi" | "manual" | "edit"; midiAssetId: string | null; userId: string },
  now: number,
): string {
  const revisionId = uuidv7(now);
  const data = JSON.stringify(tempo.map);
  db.insert(tempoMapRevisions)
    .values({
      id: revisionId,
      songId,
      source: input.source,
      data,
      midiAssetId: input.midiAssetId,
      bar1OffsetSec: tempo.bar1OffsetSec,
      createdBy: input.userId,
      createdAt: now,
    })
    .run();
  const values = {
    source: input.source,
    data,
    midiAssetId: input.midiAssetId,
    bar1OffsetSec: tempo.bar1OffsetSec,
    revisionId,
    updatedBy: input.userId,
    updatedAt: now,
  };
  db.insert(tempoMaps)
    .values({ songId, ...values })
    .onConflictDoUpdate({ target: tempoMaps.songId, set: values })
    .run();
  return revisionId;
}

/**
 * Writes the follow-up (in the caller's transaction, SPEC §24.8): moved markers and sections,
 * deleted ones soft-deleted, comments moved or made general (`context.editedOut`), and the tempo
 * map as a new revision with source `edit`. The caller bumps the timeline revision once.
 */
export function writeRemap(
  db: Db,
  songId: string,
  p: RemapPreview,
  userId: string,
  now: number,
): { tempoRevisionId: string | null } {
  const was = new Map(liveMarkerRows(db, songId).map((m) => [m.id, m]));
  for (const m of p.markers.items) {
    const w = was.get(m.id);
    if (
      w &&
      (w.startSec !== m.startSec ||
        w.endSec !== m.endSec ||
        w.startBeat !== m.startBeat ||
        w.endBeat !== m.endBeat)
    )
      db.update(markers)
        .set({
          startSec: m.startSec,
          endSec: m.endSec,
          startBeat: m.startBeat,
          endBeat: m.endBeat,
          updatedAt: now,
        })
        .where(eq(markers.id, m.id))
        .run();
  }
  if (p.markers.deleted.length > 0)
    db.update(markers)
      .set({ deletedAt: now, updatedAt: now })
      .where(inArray(markers.id, p.markers.deleted))
      .run();
  const changed = new Set([...p.comments.moved, ...p.comments.editedOut]);
  for (const c of p.comments.items) {
    if (!changed.has(c.id)) continue;
    db.update(comments)
      .set({ startSec: c.startSec, endSec: c.endSec, context: JSON.stringify(c.context) })
      .where(eq(comments.id, c.id))
      .run();
  }
  let tempoRevisionId: string | null = null;
  if (p.tempoChanged && p.tempoAfter) {
    const row = db.select().from(tempoMaps).where(eq(tempoMaps.songId, songId)).get();
    tempoRevisionId = writeTempoRevision(
      db,
      songId,
      p.tempoAfter,
      { source: "edit", midiAssetId: row?.midiAssetId ?? null, userId },
      now,
    );
  }
  return { tempoRevisionId };
}
