import {
  lengthsDiffer,
  multitrackTrackNames,
  parseCommentContext,
  suggestMultitrackName,
  uuidv7,
  type ContentRole,
  type MultitrackPreview,
} from "@bandroom/shared";
import { and, asc, eq, inArray, isNull, max } from "drizzle-orm";
import type { Db } from "../db/connection";
import {
  assets,
  commentMentions,
  commentReactions,
  comments,
  documents,
  documentVersions,
  markers,
  publicLinks,
  songGrants,
  songs,
  tempoMapRevisions,
  tempoMaps,
  tracks,
  trackVersions,
} from "../db/schema";
import { assetProbe } from "../media/assets";
import type { SongRow } from "./access";
import type { CommentRow } from "./comments";
import { afterTimelineChange } from "./markers";
import { touchProject } from "./projects";
import { createSongRow, softDeleteSong } from "./songs";
import type { ResolvedItem } from "./trash";
import type { TrackRow } from "./tracks";

// Make multitrack song, copy and move (SPEC §26.5, §26.6). Rows only: copies point at the same
// assets (usage stays with the uploader and is counted once), and no audio is re-encoded.

const SAMPLE_RATE = 48_000;
const MARKER_NOTE_MAX = 500;

/** A selected track with its song. */
export interface SourceTrack {
  track: TrackRow;
  song: SongRow;
}

function liveUserTracks(db: Db, songId: string): TrackRow[] {
  return db
    .select()
    .from(tracks)
    .where(and(eq(tracks.songId, songId), isNull(tracks.deletedAt), eq(tracks.isSystem, false)))
    .orderBy(asc(tracks.sortOrder), asc(tracks.createdAt))
    .all();
}

/**
 * The tracks a multitrack batch works on, in selection order: a song stands for all its live
 * tracks (in their order), then the selected tracks. Duplicates count once; the automatic mix is
 * never part of it.
 */
export function multitrackSources(db: Db, items: readonly ResolvedItem[]): SourceTrack[] {
  const out: SourceTrack[] = [];
  const seen = new Set<string>();
  const add = (track: TrackRow, song: SongRow) => {
    if (seen.has(track.id) || track.isSystem || track.deletedAt !== null) return;
    seen.add(track.id);
    out.push({ track, song });
  };
  for (const item of items)
    if (item.kind === "song") {
      for (const t of liveUserTracks(db, item.song.id)) add(t, item.song);
    }
  for (const item of items) if (item.kind === "track" && item.track) add(item.track, item.song);
  return out;
}

/** Source songs in selection order, with their selected tracks. */
function groupBySong(sources: readonly SourceTrack[]): { song: SongRow; tracks: TrackRow[] }[] {
  const groups = new Map<string, { song: SongRow; tracks: TrackRow[] }>();
  for (const s of sources) {
    const g = groups.get(s.song.id) ?? { song: s.song, tracks: [] };
    g.tracks.push(s.track);
    groups.set(s.song.id, g);
  }
  return [...groups.values()];
}

/**
 * Name and role of each source track in the new song (SPEC §26.5): the shared default
 * ({@link multitrackTrackNames}), with the names chosen in the dialog winning.
 */
function finalTrackNames(
  sources: readonly SourceTrack[],
  names: Readonly<Record<string, string>> = {},
): Map<string, { name: string; role: "track" | "mix" }> {
  const defaults = multitrackTrackNames(
    sources.map(({ track, song }) => ({
      name: track.name,
      role: track.role,
      songId: song.id,
      songTitle: song.title,
    })),
  );
  const out = new Map<string, { name: string; role: "track" | "mix" }>();
  sources.forEach(({ track }, i) => {
    const d = defaults[i] ?? { name: track.name, role: track.role };
    const chosen = Object.hasOwn(names, track.id) ? names[track.id]?.trim() : undefined;
    out.set(track.id, { name: chosen || d.name, role: d.role });
  });
  return out;
}

/** Source songs whose every live track is selected (they would be left empty). */
function emptiedSongIds(db: Db, groups: ReturnType<typeof groupBySong>): Set<string> {
  const out = new Set<string>();
  for (const g of groups) {
    const chosen = new Set(g.tracks.map((t) => t.id));
    if (liveUserTracks(db, g.song.id).every((t) => chosen.has(t.id))) out.add(g.song.id);
  }
  return out;
}

/** What the make-multitrack dialog shows (SPEC §26.5); nothing is changed. */
export function multitrackPreview(db: Db, sources: readonly SourceTrack[]): MultitrackPreview {
  const groups = groupBySong(sources);
  const emptied = emptiedSongIds(db, groups);
  const final = finalTrackNames(sources);
  const out = sources.map(({ track, song }) => {
    const row = track.currentVersionId
      ? db
          .select({ asset: assets })
          .from(trackVersions)
          .innerJoin(assets, eq(assets.id, trackVersions.assetId))
          .where(eq(trackVersions.id, track.currentVersionId))
          .get()
      : undefined;
    const probe = row ? assetProbe(row.asset) : null;
    return {
      id: track.id,
      name: final.get(track.id)?.name ?? track.name,
      songId: song.id,
      songTitle: song.title,
      durationSec: probe?.durationSec ?? null,
    };
  });
  return {
    tracks: out,
    songs: groups.map((g) => ({
      id: g.song.id,
      title: g.song.title,
      emptied: emptied.has(g.song.id),
    })),
    suggestedName: suggestMultitrackName(groups.map((g) => g.song.title)),
    lengthsDiffer: lengthsDiffer(out.map((t) => t.durationSec)),
  };
}

/**
 * How far a source song's tracks move so the earliest starts at 0 (SPEC §26.5): tracks from one
 * song keep their relative offsets, tracks from different songs all start at 0.
 */
function startShift(db: Db, trackIds: readonly string[]): number {
  if (trackIds.length === 0) return 0;
  const row = db
    .select({ offsets: trackVersions.offsetSamples })
    .from(trackVersions)
    .where(and(inArray(trackVersions.trackId, [...trackIds]), isNull(trackVersions.deletedAt)))
    .all();
  return row.length === 0 ? 0 : Math.min(...row.map((r) => r.offsets));
}

const retime = (sec: number | null, shiftSec: number) =>
  sec === null || shiftSec === 0 ? sec : Math.max(0, sec - shiftSec);

// ——— copying rows ——————————————————————————————————————————————————————————————————————

interface IdMaps {
  tracks: Map<string, string>;
  versions: Map<string, string>;
  revisions: Map<string, string>;
}

const newMaps = (): IdMaps => ({ tracks: new Map(), versions: new Map(), revisions: new Map() });

/** Copies a track with its live versions (same assets) into another song. */
function copyTrack(
  db: Db,
  track: TrackRow,
  songId: string,
  sortOrder: number,
  shiftSamples: number,
  maps: IdMaps,
  now: number,
  override?: { name: string; role: "track" | "mix" },
): string {
  const id = uuidv7(now);
  maps.tracks.set(track.id, id);
  const versions = db
    .select()
    .from(trackVersions)
    .where(
      and(
        eq(trackVersions.trackId, track.id),
        isNull(trackVersions.deletedAt),
        eq(trackVersions.isAutoMix, false),
      ),
    )
    .orderBy(asc(trackVersions.number))
    .all();
  db.insert(tracks)
    .values({
      ...track,
      ...override,
      id,
      songId,
      sortOrder,
      currentVersionId: null,
      deletedAt: null,
      deletedBy: null,
    })
    .run();
  for (const v of versions) {
    const vid = uuidv7(now);
    maps.versions.set(v.id, vid);
    db.insert(trackVersions)
      .values({ ...v, id: vid, trackId: id, offsetSamples: v.offsetSamples - shiftSamples })
      .run();
  }
  const current =
    (track.currentVersionId && maps.versions.get(track.currentVersionId)) ??
    (versions.length > 0 ? maps.versions.get(versions[versions.length - 1]?.id ?? "") : undefined);
  if (current) db.update(tracks).set({ currentVersionId: current }).where(eq(tracks.id, id)).run();
  return id;
}

function remapContext(json: string, maps: IdMaps): string {
  const ctx = parseCommentContext(json);
  const trackVersions: Record<string, string> = {};
  for (const [t, v] of Object.entries(ctx.trackVersions)) {
    trackVersions[maps.tracks.get(t) ?? t] = maps.versions.get(v) ?? v;
  }
  const tempoRev = ctx.tempoRev ? (maps.revisions.get(ctx.tempoRev) ?? ctx.tempoRev) : ctx.tempoRev;
  return JSON.stringify({ ...ctx, trackVersions, tempoRev });
}

/**
 * Copies comments (threads, authors, timestamps, resolved state, reactions and mentions) into
 * another song. Tracks that were not copied make their comments song-wide.
 */
function copyComments(
  db: Db,
  rows: readonly CommentRow[],
  songId: string,
  maps: IdMaps,
  shiftSec: number,
  now: number,
): number {
  if (rows.length === 0) return 0;
  const ids = new Map(rows.map((r) => [r.id, uuidv7(now)]));
  const ordered = [...rows].sort(
    (a, b) => Number(a.parentId !== null) - Number(b.parentId !== null),
  );
  for (const r of ordered) {
    const parentId = r.parentId === null ? null : (ids.get(r.parentId) ?? null);
    if (r.parentId !== null && parentId === null) continue; // reply without its thread
    db.insert(comments)
      .values({
        ...r,
        id: ids.get(r.id) ?? uuidv7(now),
        songId,
        trackId: r.trackId === null ? null : (maps.tracks.get(r.trackId) ?? null),
        parentId,
        context: remapContext(r.context, maps),
        startSec: retime(r.startSec, shiftSec),
        endSec: retime(r.endSec, shiftSec),
      })
      .run();
  }
  const old = [...ids.keys()];
  for (const x of db
    .select()
    .from(commentReactions)
    .where(inArray(commentReactions.commentId, old))
    .all()) {
    const commentId = ids.get(x.commentId);
    if (commentId)
      db.insert(commentReactions)
        .values({ ...x, id: uuidv7(now), commentId })
        .run();
  }
  for (const m of db
    .select()
    .from(commentMentions)
    .where(inArray(commentMentions.commentId, old))
    .all()) {
    const commentId = ids.get(m.commentId);
    if (commentId)
      db.insert(commentMentions)
        .values({ ...m, commentId })
        .run();
  }
  return ids.size;
}

/**
 * Copies live markers and sections. `from` (a later source of a multitrack song) adds "from
 * <song>" to the note and makes them time-anchored: the tempo map is the first source's.
 */
function copyMarkers(
  db: Db,
  fromSongId: string,
  songId: string,
  shiftSec: number,
  from: string | null,
  now: number,
): number {
  const rows = db
    .select()
    .from(markers)
    .where(and(eq(markers.songId, fromSongId), isNull(markers.deletedAt)))
    .all();
  for (const m of rows) {
    db.insert(markers)
      .values({
        ...m,
        id: uuidv7(now),
        songId,
        startSec: retime(m.startSec, shiftSec) ?? 0,
        endSec: retime(m.endSec, shiftSec),
        note:
          from === null
            ? m.note
            : (m.note ? `${m.note} · ${from}` : from).slice(0, MARKER_NOTE_MAX),
        ...(from !== null && { anchor: "time" as const, startBeat: null, endBeat: null }),
        updatedAt: now,
      })
      .run();
  }
  return rows.length;
}

/**
 * Copies the tempo map: with `history` all revisions (a song copy), else the current state as one
 * new revision by `userId` (a multitrack song). Bar 1 moves with the shift.
 */
function copyTempo(
  db: Db,
  fromSongId: string,
  songId: string,
  shiftSec: number,
  maps: IdMaps,
  opts: { history: boolean; userId: string },
  now: number,
): boolean {
  const row = db.select().from(tempoMaps).where(eq(tempoMaps.songId, fromSongId)).get();
  if (!row) return false;
  const revisions = opts.history
    ? db
        .select()
        .from(tempoMapRevisions)
        .where(eq(tempoMapRevisions.songId, fromSongId))
        .orderBy(asc(tempoMapRevisions.createdAt))
        .all()
    : [];
  for (const r of revisions) {
    const id = uuidv7(now);
    maps.revisions.set(r.id, id);
    db.insert(tempoMapRevisions)
      .values({ ...r, id, songId, bar1OffsetSec: r.bar1OffsetSec - shiftSec })
      .run();
  }
  let revisionId = maps.revisions.get(row.revisionId);
  if (revisionId === undefined) {
    revisionId = uuidv7(now);
    maps.revisions.set(row.revisionId, revisionId);
    db.insert(tempoMapRevisions)
      .values({
        id: revisionId,
        songId,
        source: row.source,
        data: row.data,
        midiAssetId: row.midiAssetId,
        bar1OffsetSec: row.bar1OffsetSec - shiftSec,
        createdBy: opts.userId,
        createdAt: now,
      })
      .run();
  }
  db.insert(tempoMaps)
    .values({
      ...row,
      songId,
      bar1OffsetSec: row.bar1OffsetSec - shiftSec,
      revisionId,
      ...(!opts.history && { updatedBy: opts.userId, updatedAt: now }),
    })
    .run();
  return true;
}

/** Copies the song's live documents with their live versions (same assets). */
function copyDocuments(
  db: Db,
  fromSongId: string,
  songId: string,
  projectId: string,
  now: number,
): number {
  const docs = db
    .select()
    .from(documents)
    .where(and(eq(documents.songId, fromSongId), isNull(documents.deletedAt)))
    .all();
  for (const d of docs) {
    const id = uuidv7(now);
    const versions = db
      .select()
      .from(documentVersions)
      .where(and(eq(documentVersions.documentId, d.id), isNull(documentVersions.deletedAt)))
      .orderBy(asc(documentVersions.number))
      .all();
    db.insert(documents)
      .values({ ...d, id, projectId, songId, currentVersionId: null })
      .run();
    const vmap = new Map<string, string>();
    for (const v of versions) {
      const vid = uuidv7(now);
      vmap.set(v.id, vid);
      db.insert(documentVersions)
        .values({ ...v, id: vid, documentId: id })
        .run();
    }
    const current =
      (d.currentVersionId && vmap.get(d.currentVersionId)) ??
      vmap.get(versions[versions.length - 1]?.id ?? "");
    if (current)
      db.update(documents).set({ currentVersionId: current }).where(eq(documents.id, id)).run();
  }
  return docs.length;
}

// ——— make multitrack song ————————————————————————————————————————————————————————————————

export interface TransferredTrack {
  /** The track in the new song (the same id when moved). */
  id: string;
  fromTrackId: string;
  fromSongId: string;
  name: string;
  role: "track" | "mix";
  /** The name and role before, when the new song renamed the track or changed its role. */
  changed: { name: string; role: "track" | "mix" } | null;
}

export interface MultitrackResult {
  song: SongRow;
  tracks: TransferredTrack[];
  /** Source songs in selection order. */
  sourceSongIds: string[];
  /** Source songs left without tracks, now in the Trash (moves only). */
  emptied: SongRow[];
}

/**
 * Makes one new song from the tracks (SPEC §26.5, §26.6), in one transaction of the caller:
 * - `move`: the tracks move with all their versions; comments on them move along (and the
 *   song-wide comments and documents of a source left empty, which goes to the Trash);
 * - `copy`: the tracks and their live versions are copied (same assets), with their comments.
 * Each source song's tracks shift so its earliest version starts at 0. Markers and sections of
 * every source are copied (later sources' get "from <song>" via `fromLabel`); the tempo map comes
 * from the first source. Tracks get their final names and roles ({@link multitrackTrackNames},
 * then the dialog's `names`).
 */
export function makeMultitrackSong(
  db: Db,
  input: {
    mode: "move" | "copy";
    sources: readonly SourceTrack[];
    name: string;
    projectId: string;
    userId: string;
    fromLabel: (songTitle: string) => string;
    /** Names chosen in the dialog, per source track id. */
    names?: Readonly<Record<string, string>>;
  },
  now: number = Date.now(),
): MultitrackResult {
  const groups = groupBySong(input.sources);
  const final = finalTrackNames(input.sources, input.names);
  const emptiedIds = input.mode === "move" ? emptiedSongIds(db, groups) : new Set<string>();
  const song = createSongRow(
    db,
    { projectId: input.projectId, title: input.name, createdBy: input.userId },
    now,
  );
  const out: TransferredTrack[] = [];
  let order = 0;
  groups.forEach((g, gi) => {
    const shift = startShift(
      db,
      g.tracks.map((t) => t.id),
    );
    const shiftSec = shift / SAMPLE_RATE;
    const maps = newMaps();
    for (const t of g.tracks) {
      const f = final.get(t.id) ?? { name: t.name, role: t.role };
      const changed =
        f.name !== t.name || f.role !== t.role ? { name: t.name, role: t.role } : null;
      if (input.mode === "move") {
        db.update(tracks)
          .set({ songId: song.id, sortOrder: order++, name: f.name, role: f.role })
          .where(eq(tracks.id, t.id))
          .run();
        if (shift !== 0) {
          for (const v of db
            .select()
            .from(trackVersions)
            .where(eq(trackVersions.trackId, t.id))
            .all())
            db.update(trackVersions)
              .set({ offsetSamples: v.offsetSamples - shift })
              .where(eq(trackVersions.id, v.id))
              .run();
        }
        out.push({
          id: t.id,
          fromTrackId: t.id,
          fromSongId: g.song.id,
          name: f.name,
          role: f.role,
          changed,
        });
      } else {
        const id = copyTrack(db, t, song.id, order++, shift, maps, now, f);
        out.push({
          id,
          fromTrackId: t.id,
          fromSongId: g.song.id,
          name: f.name,
          role: f.role,
          changed,
        });
      }
    }
    const trackIds = g.tracks.map((t) => t.id);
    const emptied = emptiedIds.has(g.song.id);
    // Threads on the tracks (and, for a source left empty, its song-wide threads).
    const roots = db
      .select()
      .from(comments)
      .where(and(eq(comments.songId, g.song.id), isNull(comments.parentId)))
      .all()
      .filter((c) => (c.trackId === null ? emptied : trackIds.includes(c.trackId)));
    const rootIds = roots.map((c) => c.id);
    const replies =
      rootIds.length === 0
        ? []
        : db.select().from(comments).where(inArray(comments.parentId, rootIds)).all();
    if (input.mode === "move") {
      for (const c of [...roots, ...replies]) {
        db.update(comments)
          .set({
            songId: song.id,
            startSec: retime(c.startSec, shiftSec),
            endSec: retime(c.endSec, shiftSec),
          })
          .where(eq(comments.id, c.id))
          .run();
      }
      if (emptied) {
        db.update(documents)
          .set({ songId: song.id, projectId: input.projectId })
          .where(and(eq(documents.songId, g.song.id), isNull(documents.deletedAt)))
          .run();
      }
    }
    if (gi === 0)
      copyTempo(
        db,
        g.song.id,
        song.id,
        shiftSec,
        maps,
        { history: false, userId: input.userId },
        now,
      );
    if (input.mode === "copy")
      copyComments(db, [...roots, ...replies], song.id, maps, shiftSec, now);
    copyMarkers(
      db,
      g.song.id,
      song.id,
      shiftSec,
      gi === 0 ? null : input.fromLabel(g.song.title),
      now,
    );
  });
  afterTimelineChange(db, song.id, now);
  const emptied: SongRow[] = [];
  for (const g of groups) {
    if (!emptiedIds.has(g.song.id)) {
      db.update(songs).set({ updatedAt: now }).where(eq(songs.id, g.song.id)).run();
      continue;
    }
    softDeleteSong(db, g.song, now, input.userId);
    emptied.push(g.song);
  }
  for (const projectId of new Set(groups.map((g) => g.song.projectId)))
    touchProject(db, projectId, now);
  const fresh = db.select().from(songs).where(eq(songs.id, song.id)).get() ?? song;
  return { song: fresh, tracks: out, sourceSongIds: groups.map((g) => g.song.id), emptied };
}

// ——— songs to another project ———————————————————————————————————————————————————————————

function nextSortOrder(db: Db, projectId: string): number {
  const last = db
    .select({ m: max(songs.sortOrder) })
    .from(songs)
    .where(and(eq(songs.projectId, projectId), isNull(songs.deletedAt)))
    .get();
  return (last?.m ?? -1) + 1;
}

/**
 * Copies a song into a project (SPEC §26.6): tracks with their live versions (same assets),
 * markers and sections, the tempo map with its history, comments (threads, authors, timestamps,
 * reactions, mentions) and documents (same assets). Grants, links, follows, mixer settings,
 * visits and the automatic mix are not copied (the mix is rendered again).
 */
export function copySongTo(
  db: Db,
  from: SongRow,
  projectId: string,
  userId: string,
  now: number = Date.now(),
): SongRow {
  const created = createSongRow(
    db,
    { projectId, title: from.title, subtitle: from.subtitle, key: from.key, createdBy: userId },
    now,
  );
  const song = db
    .update(songs)
    .set({ notes: from.notes, downloadPolicy: from.downloadPolicy })
    .where(eq(songs.id, created.id))
    .returning()
    .get();
  const maps = newMaps();
  liveUserTracks(db, from.id).forEach((t, i) => copyTrack(db, t, song.id, i, 0, maps, now));
  copyMarkers(db, from.id, song.id, 0, null, now);
  copyTempo(db, from.id, song.id, 0, maps, { history: true, userId }, now);
  copyComments(
    db,
    db.select().from(comments).where(eq(comments.songId, from.id)).all(),
    song.id,
    maps,
    0,
    now,
  );
  copyDocuments(db, from.id, song.id, projectId, now);
  return song;
}

/**
 * Moves a song into another project (SPEC §26.6): its documents and links go along (links keep
 * working); song grants are dropped, since they refine the old project's roles (SPEC §3.2).
 * Returns the dropped grants.
 */
export function moveSongTo(
  db: Db,
  song: SongRow,
  projectId: string,
  now: number = Date.now(),
): { userId: string; role: ContentRole }[] {
  db.update(songs)
    .set({ projectId, sortOrder: nextSortOrder(db, projectId), updatedAt: now })
    .where(eq(songs.id, song.id))
    .run();
  db.update(documents).set({ projectId }).where(eq(documents.songId, song.id)).run();
  db.update(publicLinks)
    .set({ projectId, updatedAt: now })
    .where(eq(publicLinks.songId, song.id))
    .run();
  const dropped = db
    .delete(songGrants)
    .where(eq(songGrants.songId, song.id))
    .returning({ userId: songGrants.userId, role: songGrants.role })
    .all();
  touchProject(db, song.projectId, now);
  touchProject(db, projectId, now);
  return dropped;
}

/** How many live tracks a song keeps when these tracks leave it (the automatic mix not counted). */
export function tracksLeftAfter(db: Db, songId: string, trackIds: readonly string[]): number {
  const leaving = new Set(trackIds);
  return liveUserTracks(db, songId).filter((t) => !leaving.has(t.id)).length;
}
