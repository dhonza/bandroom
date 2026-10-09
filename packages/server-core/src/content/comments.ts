import {
  parseCommentContext,
  roleAtLeast,
  uuidv7,
  type Comment,
  type CommentAuthor,
  type CommentContext,
  type CommentReply,
  type MentionableUser,
} from "@bandroom/shared";
import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../db/connection";
import {
  commentMentions,
  commentReactions,
  comments,
  tempoMaps,
  tracks,
  trackVersions,
  users,
} from "../db/schema";
import type { UserRow } from "../auth/users";
import { resolveSongAccess } from "./access";
import { visibleVersion } from "./visibleVersions";

export type CommentRow = typeof comments.$inferSelect;

/** Includes soft-deleted rows (restore needs them). */
export function getCommentRow(db: Db, id: string): CommentRow | undefined {
  return db.select().from(comments).where(eq(comments.id, id)).get();
}

/** Song id owning a comment (for scope resolution); deleted comments still resolve for undo. */
export function songIdOfComment(db: Db, id: string): string | undefined {
  return getCommentRow(db, id)?.songId;
}

// ——— reading ————————————————————————————————————————————————————————————————————————————

interface UserInfo {
  displayName: string;
  username: string;
}

function userInfo(db: Db, ids: readonly string[]): Map<string, UserInfo> {
  if (ids.length === 0) return new Map();
  const rows = db
    .select({ id: users.id, displayName: users.displayName, username: users.username })
    .from(users)
    .where(and(inArray(users.id, [...new Set(ids)]), isNull(users.deletedAt)))
    .all();
  return new Map(rows.map((r) => [r.id, r]));
}

function authorOf(r: CommentRow, info: Map<string, UserInfo>): CommentAuthor {
  const u = r.authorUserId ? info.get(r.authorUserId) : undefined;
  if (u) return { userId: r.authorUserId, name: u.displayName, username: u.username, kind: "user" };
  if (r.importedAuthorName)
    return { userId: null, name: r.importedAuthorName, username: null, kind: "imported" };
  if (r.anonymousName) return { userId: null, name: r.anonymousName, username: null, kind: "link" };
  return { userId: null, name: "", username: null, kind: "deleted" };
}

/** Builds DTOs for rows (reactions, mentions and names loaded in bulk). */
function toDtos(db: Db, rows: readonly CommentRow[], viewerId: string): CommentReply[] {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const reactionRows = db
    .select({
      commentId: commentReactions.commentId,
      emoji: commentReactions.emoji,
      n: sql<number>`count(*)`,
      mine: sql<number>`sum(case when ${commentReactions.userId} = ${viewerId} then 1 else 0 end)`,
      first: sql<number>`min(${commentReactions.createdAt})`,
    })
    .from(commentReactions)
    .where(inArray(commentReactions.commentId, ids))
    .groupBy(commentReactions.commentId, commentReactions.emoji)
    .orderBy(sql`min(${commentReactions.createdAt})`)
    .all();
  const mentionRows = db
    .select()
    .from(commentMentions)
    .where(inArray(commentMentions.commentId, ids))
    .all();
  const info = userInfo(
    db,
    rows.flatMap((r) => [r.authorUserId, r.resolvedBy].filter((x): x is string => x !== null)),
  );
  return rows.map((r) => {
    const deleted = r.deletedAt !== null;
    return {
      id: r.id,
      songId: r.songId,
      trackId: r.trackId,
      parentId: r.parentId,
      author: authorOf(r, info),
      body: deleted ? "" : r.body,
      startSec: r.startSec,
      endSec: r.endSec,
      context: parseCommentContext(r.context),
      source: r.source,
      resolvedAt: r.resolvedAt,
      resolvedByName: r.resolvedBy ? (info.get(r.resolvedBy)?.displayName ?? null) : null,
      createdAt: r.createdAt,
      editedAt: r.editedAt,
      deleted,
      reactions: deleted
        ? []
        : reactionRows
            .filter((x) => x.commentId === r.id)
            .map((x) => ({ emoji: x.emoji, count: x.n, mine: x.mine > 0 })),
      mentions: deleted ? [] : mentionRows.filter((m) => m.commentId === r.id).map((m) => m.userId),
    };
  });
}

/** Cursor = `createdAt:id` of the last item of the previous page (comments, notifications). */
export function parseTimeCursor(cursor: string | undefined): { at: number; id: string } | null {
  if (!cursor) return null;
  const m = /^(\d{1,16}):([\w-]{1,64})$/.exec(cursor);
  return m ? { at: Number(m[1]), id: m[2] ?? "" } : null;
}

const liveReplyExists = sql`exists (select 1 from ${comments} r where r.parent_id = ${comments.id} and r.deleted_at is null)`;

/**
 * Top-level comments of a song, oldest first, with live replies embedded (SPEC §8). A deleted
 * comment with live replies stays as a "deleted comment" placeholder; without replies it is gone.
 */
export function listSongComments(
  db: Db,
  songId: string,
  viewerId: string,
  opts: {
    cursor?: { at: number; id: string } | null;
    limit: number;
    /** Public-link visitors without band comments see only this link's comments (SPEC §3.5). */
    onlyLinkId?: string;
  },
): { comments: Comment[]; nextCursor: string | null } {
  const c = opts.cursor;
  const onlyLink = opts.onlyLinkId;
  const top = db
    .select()
    .from(comments)
    .where(
      and(
        eq(comments.songId, songId),
        isNull(comments.parentId),
        onlyLink ? eq(comments.linkId, onlyLink) : undefined,
        or(isNull(comments.deletedAt), liveReplyExists),
        c
          ? or(
              gt(comments.createdAt, c.at),
              and(eq(comments.createdAt, c.at), gt(comments.id, c.id)),
            )
          : undefined,
      ),
    )
    .orderBy(asc(comments.createdAt), asc(comments.id))
    .limit(opts.limit + 1)
    .all();
  const page = top.slice(0, opts.limit);
  const last = page.at(-1);
  const nextCursor = top.length > opts.limit && last ? `${last.createdAt}:${last.id}` : null;
  return { comments: withReplies(db, page, viewerId, onlyLink), nextCursor };
}

function withReplies(
  db: Db,
  top: readonly CommentRow[],
  viewerId: string,
  onlyLinkId?: string,
): Comment[] {
  const replyRows =
    top.length === 0
      ? []
      : db
          .select()
          .from(comments)
          .where(
            and(
              inArray(
                comments.parentId,
                top.map((r) => r.id),
              ),
              isNull(comments.deletedAt),
              onlyLinkId ? eq(comments.linkId, onlyLinkId) : undefined,
            ),
          )
          .orderBy(asc(comments.createdAt), asc(comments.id))
          .all();
  const dtos = toDtos(db, [...top, ...replyRows], viewerId);
  const byId = new Map(dtos.map((d) => [d.id, d]));
  return top.map((r) => {
    const d = byId.get(r.id) as CommentReply;
    return { ...d, replies: dtos.filter((x) => x.parentId === r.id) };
  });
}

/** One comment as a DTO (a top-level one with its replies); deleted ones included. */
export function commentById(
  db: Db,
  id: string,
  viewerId: string,
  onlyLinkId?: string,
): Comment | undefined {
  const row = getCommentRow(db, id);
  if (!row) return undefined;
  if (row.parentId === null) return withReplies(db, [row], viewerId, onlyLinkId)[0];
  const [dto] = toDtos(db, [row], viewerId);
  return dto && { ...dto, replies: [] };
}

// ——— writing ————————————————————————————————————————————————————————————————————————————

/**
 * The comment context (SPEC §8): the current version of every track, overridden by the versions
 * the client had loaded when they belong to that track, plus the current tempo revision.
 */
export function captureCommentContext(
  db: Db,
  songId: string,
  loaded: Record<string, string> = {},
): CommentContext {
  const rows = db
    .select({ id: tracks.id, current: tracks.currentVersionId })
    .from(tracks)
    .where(and(eq(tracks.songId, songId), isNull(tracks.deletedAt)))
    .all();
  const chosenVersions: Record<string, string> = {};
  const wanted = Object.values(loaded);
  const valid =
    wanted.length === 0
      ? new Map<string, string>()
      : new Map(
          db
            .select({ id: trackVersions.id, trackId: trackVersions.trackId })
            .from(trackVersions)
            .where(and(inArray(trackVersions.id, wanted), visibleVersion()))
            .all()
            .map((v) => [v.id, v.trackId]),
        );
  for (const t of rows) {
    const chosen = loaded[t.id];
    if (chosen && valid.get(chosen) === t.id) chosenVersions[t.id] = chosen;
    else if (t.current) chosenVersions[t.id] = t.current;
  }
  const tempoRev =
    db
      .select({ rev: tempoMaps.revisionId })
      .from(tempoMaps)
      .where(eq(tempoMaps.songId, songId))
      .get()?.rev ?? null;
  return { trackVersions: chosenVersions, tempoRev };
}

export interface NewComment {
  songId: string;
  /** Null for a public-link visitor (then `linkId` and `anonymousName` are set). */
  authorUserId: string | null;
  linkId?: string | null;
  anonymousName?: string | null;
  body: string;
  startSec: number | null;
  endSec: number | null;
  trackId: string | null;
  parentId: string | null;
  context: CommentContext;
}

export function createCommentRow(db: Db, c: NewComment, now: number = Date.now()): CommentRow {
  return db
    .insert(comments)
    .values({
      id: uuidv7(now),
      songId: c.songId,
      trackId: c.trackId,
      parentId: c.parentId,
      authorUserId: c.authorUserId,
      linkId: c.linkId ?? null,
      anonymousName: c.anonymousName ?? null,
      body: c.body,
      startSec: c.startSec,
      endSec: c.endSec,
      context: JSON.stringify(c.context),
      source: c.linkId ? "link" : "app",
      createdAt: now,
    })
    .returning()
    .get();
}

/** Whether a track belongs to the song (and is not deleted or the hidden mix). */
export function isSongTrack(db: Db, songId: string, trackId: string): boolean {
  return (
    db
      .select({ id: tracks.id })
      .from(tracks)
      .where(and(eq(tracks.id, trackId), eq(tracks.songId, songId), isNull(tracks.deletedAt)))
      .get() !== undefined
  );
}

export function updateCommentBody(db: Db, id: string, body: string, now = Date.now()): void {
  db.update(comments).set({ body, editedAt: now }).where(eq(comments.id, id)).run();
}

/** Moves a comment (null start = general comment); not an edit of its text (no `editedAt`). */
export function setCommentTimes(
  db: Db,
  id: string,
  startSec: number | null,
  endSec: number | null,
): void {
  db.update(comments).set({ startSec, endSec }).where(eq(comments.id, id)).run();
}

export function setCommentDeleted(db: Db, id: string, deleted: boolean, now = Date.now()): void {
  db.update(comments)
    .set({ deletedAt: deleted ? now : null })
    .where(eq(comments.id, id))
    .run();
}

export function setCommentResolved(db: Db, id: string, by: string | null, now = Date.now()): void {
  db.update(comments)
    .set(by === null ? { resolvedAt: null, resolvedBy: null } : { resolvedAt: now, resolvedBy: by })
    .where(eq(comments.id, id))
    .run();
}

/** Adds or removes a reaction; returns whether anything changed. */
export function setCommentReactionRow(
  db: Db,
  commentId: string,
  userId: string,
  emoji: string,
  active: boolean,
  now = Date.now(),
): boolean {
  if (active) {
    const r = db
      .insert(commentReactions)
      .values({ id: uuidv7(now), commentId, userId, emoji, createdAt: now })
      .onConflictDoNothing()
      .run();
    return r.changes > 0;
  }
  const r = db
    .delete(commentReactions)
    .where(
      and(
        eq(commentReactions.commentId, commentId),
        eq(commentReactions.userId, userId),
        eq(commentReactions.emoji, emoji),
      ),
    )
    .run();
  return r.changes > 0;
}

/** Replaces the mentions of a comment; returns the user ids newly mentioned. */
export function setCommentMentions(
  db: Db,
  commentId: string,
  userIds: readonly string[],
): string[] {
  const before = new Set(
    db
      .select({ u: commentMentions.userId })
      .from(commentMentions)
      .where(eq(commentMentions.commentId, commentId))
      .all()
      .map((r) => r.u),
  );
  db.delete(commentMentions).where(eq(commentMentions.commentId, commentId)).run();
  const unique = [...new Set(userIds)];
  if (unique.length > 0) {
    db.insert(commentMentions)
      .values(unique.map((userId) => ({ commentId, userId })))
      .run();
  }
  return unique.filter((u) => !before.has(u));
}

// ——— mentions ———————————————————————————————————————————————————————————————————————————

/** Enabled users who can view the song (SPEC §8 mention autocomplete), by display name. */
export function mentionableUsers(db: Db, songId: string): MentionableUser[] {
  const all = db
    .select()
    .from(users)
    .where(and(isNull(users.disabledAt), isNull(users.deletedAt)))
    .all() as UserRow[];
  return all
    .filter((u) => {
      const a = resolveSongAccess(db, u, songId);
      return a !== undefined && roleAtLeast(a.role, "viewer");
    })
    .map((u) => ({ id: u.id, username: u.username, displayName: u.displayName }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** Uploaders of the song's versions: "comment on a song I uploaded to". */
export function songUploaderIds(db: Db, songId: string): string[] {
  return db
    .selectDistinct({ u: trackVersions.uploadedBy })
    .from(trackVersions)
    .innerJoin(tracks, eq(tracks.id, trackVersions.trackId))
    .where(and(eq(tracks.songId, songId), visibleVersion()))
    .all()
    .map((r) => r.u)
    .filter((u): u is string => u !== null);
}
