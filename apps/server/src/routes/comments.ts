import {
  captureCommentContext,
  commentById,
  createCommentRow,
  getCommentRow,
  isSongTrack,
  listSongComments as listSongCommentRows,
  mentionableUsers,
  parseTimeCursor,
  setCommentDeleted,
  setCommentMentions,
  setCommentReactionRow,
  setCommentResolved,
  songUploaderIds,
  storeClientResponse,
  storedClientResponse,
  updateCommentBody,
  type CommentRow,
  type SongAccess,
} from "@bandroom/server-core";
import {
  canActOnComment,
  createComment,
  deleteComment,
  extractMentions,
  listMentionableUsers,
  listSongComments,
  resolveComment,
  restoreComment,
  setCommentReaction,
  updateComment,
  COMMENTS_PAGE_MAX,
  type Comment,
  type EffectiveRole,
  type EventAction,
} from "@bandroom/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../context";
import { audit } from "../http/audit";
import { registerContract } from "../http/contracts";
import { AppError } from "../http/errors";
import { notifyComment, notifyEditMentions } from "../notify";

/**
 * Comments (SPEC §8): point/range/track comments, one level of replies, reactions, resolve,
 * mentions. Commenters act on their own comments, editors on anyone's (canActOnComment).
 */
export function registerCommentRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  const find = (id: string): CommentRow => {
    const row = getCommentRow(db, id);
    if (!row) throw new AppError("NOT_FOUND", "Comment not found");
    return row;
  };
  const owned = (id: string, role: EffectiveRole, userId: string): CommentRow => {
    const row = find(id);
    if (!canActOnComment(role, row.authorUserId !== null && row.authorUserId === userId)) {
      throw new AppError("FORBIDDEN", "Not your comment");
    }
    return row;
  };
  const dto = (id: string, userId: string): Comment => {
    const c = commentById(db, id, userId);
    if (!c) throw new AppError("NOT_FOUND", "Comment not found");
    return c;
  };
  const mentionIds = (songId: string, body: string): string[] => {
    const names = extractMentions(body);
    if (names.length === 0) return [];
    return mentionableUsers(db, songId)
      .filter((u) => names.includes(u.username))
      .map((u) => u.id);
  };
  const changed = (
    request: FastifyRequest,
    access: SongAccess,
    action: EventAction,
    row: CommentRow,
    details: Record<string, unknown> = {},
  ) => {
    audit(db, request, {
      action,
      projectId: access.project.id,
      songId: access.song.id,
      targetType: "comment",
      targetId: row.id,
      details: { parentId: row.parentId, ...details },
    });
    ctx.hub.publish({
      type: "comment.changed",
      projectId: access.project.id,
      songId: access.song.id,
      data: { commentId: row.id, parentId: row.parentId, action },
    });
  };

  registerContract(app, listSongComments, ({ access, query, user }) => {
    const cursor = parseTimeCursor(query.cursor);
    if (query.cursor && !cursor) throw new AppError("BAD_REQUEST", "Invalid cursor");
    return listSongCommentRows(db, access.song.id, user.id, {
      cursor,
      limit: query.limit ?? COMMENTS_PAGE_MAX,
    });
  });

  registerContract(
    app,
    createComment,
    ({ access, body, user }, request) => {
      const route = "createComment";
      if (body.requestId) {
        const stored = storedClientResponse(db, user.id, body.requestId, route);
        if (stored !== undefined) return stored as { comment: Comment };
      }
      const songId = access.song.id;
      let parent: CommentRow | null = null;
      if (body.parentId) {
        const p = getCommentRow(db, body.parentId);
        if (!p || p.songId !== songId || p.deletedAt !== null)
          throw new AppError("NOT_FOUND", "Comment not found");
        // Replies are one level deep: a reply to a reply joins its top-level comment.
        parent = p.parentId ? (getCommentRow(db, p.parentId) ?? null) : p;
        if (!parent || parent.deletedAt !== null)
          throw new AppError("NOT_FOUND", "Comment not found");
      }
      const trackId = parent ? null : (body.trackId ?? null);
      if (trackId && !isSongTrack(db, songId, trackId))
        throw new AppError("BAD_REQUEST", "Unknown track");
      const row = createCommentRow(db, {
        songId,
        authorUserId: user.id,
        body: body.body,
        startSec: parent ? null : (body.startSec ?? null),
        endSec: parent ? null : (body.endSec ?? null),
        trackId,
        parentId: parent?.id ?? null,
        context: captureCommentContext(db, songId, body.context?.trackVersions),
      });
      const mentioned = setCommentMentions(db, row.id, mentionIds(songId, row.body));
      changed(request, access, "comment.created", row, {
        startSec: row.startSec,
        endSec: row.endSec,
        trackId: row.trackId,
        mentions: mentioned.length,
      });
      notifyComment(ctx, {
        actor: user,
        project: access.project,
        song: access.song,
        comment: { id: row.id, body: row.body, startSec: parent?.startSec ?? row.startSec },
        mentioned,
        parentAuthorId: parent?.authorUserId ?? null,
        uploaderIds: parent ? [] : songUploaderIds(db, songId),
      });
      const response = { comment: dto(row.id, user.id) };
      if (body.requestId) storeClientResponse(db, user.id, body.requestId, route, response);
      return response;
    },
    { rateLimit: { max: 30, timeWindow: "1 minute" } },
  );

  registerContract(app, updateComment, ({ access, params, body, user }, request) => {
    const row = owned(params.id, access.role, user.id);
    if (row.deletedAt !== null) throw new AppError("NOT_FOUND", "Comment not found");
    if (row.body !== body.body) {
      updateCommentBody(db, row.id, body.body);
      const added = setCommentMentions(db, row.id, mentionIds(access.song.id, body.body));
      changed(request, access, "comment.edited", row);
      const top = row.parentId ? getCommentRow(db, row.parentId) : row;
      notifyEditMentions(ctx, {
        actor: user,
        project: access.project,
        song: access.song,
        comment: { id: row.id, body: body.body, startSec: top?.startSec ?? null },
        mentioned: added,
      });
    }
    return { comment: dto(row.id, user.id) };
  });

  registerContract(app, deleteComment, ({ access, params, user }, request) => {
    const row = owned(params.id, access.role, user.id);
    if (row.deletedAt === null) {
      setCommentDeleted(db, row.id, true);
      changed(request, access, "comment.deleted", row);
    }
    return { ok: true as const };
  });

  registerContract(app, restoreComment, ({ access, params, user }, request) => {
    const row = owned(params.id, access.role, user.id);
    if (row.deletedAt !== null) {
      setCommentDeleted(db, row.id, false);
      changed(request, access, "comment.restored", row);
    }
    return { comment: dto(row.id, user.id) };
  });

  registerContract(app, resolveComment, ({ access, params, body, user }, request) => {
    const row = owned(params.id, access.role, user.id);
    if (row.deletedAt !== null) throw new AppError("NOT_FOUND", "Comment not found");
    if (row.parentId !== null) throw new AppError("BAD_REQUEST", "Replies are not resolved");
    if (body.resolved !== (row.resolvedAt !== null)) {
      setCommentResolved(db, row.id, body.resolved ? user.id : null);
      changed(request, access, body.resolved ? "comment.resolved" : "comment.unresolved", row);
    }
    return { comment: dto(row.id, user.id) };
  });

  registerContract(app, setCommentReaction, ({ access, params, body, user }, request) => {
    const row = find(params.id);
    if (row.deletedAt !== null) throw new AppError("NOT_FOUND", "Comment not found");
    if (setCommentReactionRow(db, row.id, user.id, body.emoji, body.active)) {
      changed(
        request,
        access,
        body.active ? "comment.reaction_added" : "comment.reaction_removed",
        row,
        { emoji: body.emoji },
      );
    }
    return { comment: dto(row.id, user.id) };
  });

  registerContract(app, listMentionableUsers, ({ access }) => ({
    users: mentionableUsers(db, access.song.id),
  }));
}
