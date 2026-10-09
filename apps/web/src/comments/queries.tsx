import {
  canActOnComment,
  lockedOut,
  createComment,
  deleteComment,
  listMentionableUsers,
  listSongComments,
  resolveComment,
  restoreComment,
  setCommentReaction,
  updateComment,
  uuidv7,
  type Comment,
  type CommentReply,
  type CreateComment,
  type ReactionEmoji,
  type Song,
} from "@bandroom/shared";
import { Button, Group, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { enqueue, shouldQueueOffline, useOffline } from "../offline/controller";
import { tempId } from "../offline/outbox";
import { withPendingComments } from "../offline/pending";
import { useApiError } from "../api/useApiError";
import { useOptionalUser } from "../auth/session";
import { isLinkMode } from "../links/linkMode";
import { setOptimistic } from "../api/optimistic";

export const commentKeys = {
  list: (songId: string) => ["songs", songId, "comments"] as const,
  mentionable: (songId: string) => ["songs", songId, "mentionable"] as const,
};

/** `truncated`: the song has more comments than `MAX_PAGES` pages; the rest is not loaded. */
type CommentList = { comments: Comment[]; truncated?: boolean };

/** Pages through the API (SPEC §18.3) and keeps the whole song's comments for lane and panel. */
const MAX_PAGES = 20;

export function useSongComments(songId: string) {
  const q = useQuery({
    queryKey: commentKeys.list(songId),
    queryFn: async ({ signal }): Promise<CommentList> => {
      const all: Comment[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await api(
          listSongComments,
          { params: { id: songId }, query: { ...(cursor && { cursor }) } },
          { signal },
        );
        all.push(...res.comments);
        cursor = res.nextCursor ?? undefined;
        if (!cursor) break;
      }
      // Comments written offline and not sent yet (SPEC §13 outbox).
      return {
        comments: withPendingComments(all, useOffline.getState().outbox, songId),
        truncated: cursor !== undefined,
      };
    },
  });
  // Merged again here: after a reload the outbox can load after the list (SPEC §13).
  const outbox = useOffline((s) => s.outbox);
  const comments = useMemo(
    () => withPendingComments(q.data?.comments ?? [], outbox, songId),
    [q.data, outbox, songId],
  );
  return { ...q, comments, truncated: q.data?.truncated ?? false };
}

export function useMentionable(songId: string, enabled: boolean) {
  return useQuery({
    queryKey: commentKeys.mentionable(songId),
    queryFn: ({ signal }) => api(listMentionableUsers, { params: { id: songId } }, { signal }),
    enabled,
    staleTime: 60_000,
  });
}

/** Who may comment and act on which comment (SPEC §3.2, §8). */
export function useCommentPermissions(song: Song) {
  // Public-link visitors (no account) may only write comments: no edits, no reactions.
  const userId = useOptionalUser()?.id ?? "";
  // A locked song (SPEC §25.12) freezes all comment changes; `mayComment` keeps the buttons
  // visible (disabled, with the reason).
  const locked = lockedOut(song.locked !== null, "comment");
  const mayComment = song.access.capabilities.includes("comment");
  const canComment = mayComment && !locked;
  const canReact = canComment && !isLinkMode();
  const canModify = useCallback(
    (c: CommentReply) =>
      userId !== "" &&
      !locked &&
      canActOnComment(song.access.role, c.author.userId !== null && c.author.userId === userId),
    [song.access.role, userId, locked],
  );
  const isOwn = useCallback(
    (c: CommentReply) => userId !== "" && c.author.userId === userId,
    [userId],
  );
  return { canComment, canReact, canModify, isOwn, userId, mayComment, locked };
}

const UNDO_MS = 8000;

/** How a comment written offline looks until the server has it. */
function offlineComment(
  songId: string,
  body: CreateComment,
  id: string,
  user: { id: string; displayName: string; username: string },
): Comment {
  return {
    id,
    songId,
    trackId: body.parentId ? null : (body.trackId ?? null),
    parentId: body.parentId ?? null,
    author: { userId: user.id, name: user.displayName, username: user.username, kind: "user" },
    body: body.body,
    startSec: body.parentId ? null : (body.startSec ?? null),
    endSec: body.parentId ? null : (body.endSec ?? null),
    context: { trackVersions: body.context?.trackVersions ?? {}, tempoRev: null },
    source: "app",
    resolvedAt: null,
    resolvedByName: null,
    createdAt: Date.now(),
    editedAt: null,
    deleted: false,
    reactions: [],
    mentions: [],
    replies: [],
  };
}

/** Maps a comment (top-level or reply) inside the cached list. */
function mapComment(list: Comment[], id: string, fn: (c: CommentReply) => CommentReply): Comment[] {
  return list.map((c) =>
    c.id === id
      ? { ...(fn(c) as Comment), replies: c.replies }
      : c.replies.some((r) => r.id === id)
        ? { ...c, replies: c.replies.map((r) => (r.id === id ? fn(r) : r)) }
        : c,
  );
}

/**
 * Create, edit, delete (8 s undo), resolve and react, with optimistic cache updates (SPEC §11.1).
 */
export function useCommentActions(songId: string) {
  const qc = useQueryClient();
  const { t } = useTranslation();
  const apiError = useApiError();
  const user = useOptionalUser();
  const displayName = user?.displayName ?? null;
  const key = commentKeys.list(songId);

  const patch = useCallback(
    (fn: (list: Comment[]) => Comment[]) => {
      setOptimistic<CommentList>(qc, key, (old) => (old ? { comments: fn(old.comments) } : old));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key is derived from songId
    [qc, songId],
  );
  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: key });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key is derived from songId
  }, [qc, songId]);
  const fail = useCallback(
    (err: unknown) => {
      notifications.show({ color: "red", message: apiError(err) });
      refresh();
    },
    [apiError, refresh],
  );
  const replace = useCallback(
    (c: Comment) => {
      patch((list) =>
        c.parentId === null
          ? list.some((x) => x.id === c.id)
            ? list.map((x) => (x.id === c.id ? c : x))
            : [...list, c]
          : list.map((x) =>
              x.id === c.parentId
                ? {
                    ...x,
                    replies: x.replies.some((r) => r.id === c.id)
                      ? x.replies.map((r) => (r.id === c.id ? c : r))
                      : [...x.replies, c],
                  }
                : x,
            ),
      );
    },
    [patch],
  );

  const create = useCallback(
    async (body: CreateComment): Promise<Comment | null> => {
      const requestId = uuidv7();
      try {
        const { comment } = await api(createComment, {
          params: { id: songId },
          body: { ...body, requestId },
        });
        replace(comment);
        refresh();
        void qc.invalidateQueries({ queryKey: ["follows", "song", songId] }); // auto-follow
        return comment;
      } catch (err) {
        if (user && !isLinkMode() && shouldQueueOffline(err)) {
          // Offline: queue it with the same requestId and show it until it is sent (SPEC §13).
          const preview = offlineComment(songId, body, tempId(requestId), user);
          replace(preview);
          await enqueue(
            "comment.create",
            songId,
            { tempId: preview.id, body: { ...body, requestId }, preview },
            requestId,
          );
          return preview;
        }
        fail(err);
        return null;
      }
    },
    [qc, songId, replace, refresh, fail, user],
  );

  const edit = useCallback(
    async (c: CommentReply, text: string): Promise<boolean> => {
      patch((list) => mapComment(list, c.id, (x) => ({ ...x, body: text, editedAt: Date.now() })));
      try {
        const { comment } = await api(updateComment, {
          params: { id: c.id },
          body: { body: text },
        });
        replace(comment);
        return true;
      } catch (err) {
        fail(err);
        return false;
      }
    },
    [patch, replace, fail],
  );

  /** Moves a top-level comment (null start: whole song; null end: a point). */
  const move = useCallback(
    async (c: Comment, startSec: number | null, endSec: number | null): Promise<boolean> => {
      const end = startSec === null ? null : endSec;
      patch((list) => mapComment(list, c.id, (x) => ({ ...x, startSec, endSec: end })));
      try {
        const { comment } = await api(updateComment, {
          params: { id: c.id },
          body: { startSec, endSec: end },
        });
        replace(comment);
        return true;
      } catch (err) {
        fail(err);
        return false;
      }
    },
    [patch, replace, fail],
  );

  const resolve = useCallback(
    async (c: Comment, resolved: boolean): Promise<void> => {
      patch((list) =>
        mapComment(list, c.id, (x) => ({
          ...x,
          resolvedAt: resolved ? Date.now() : null,
          resolvedByName: resolved ? displayName : null,
        })),
      );
      try {
        const { comment } = await api(resolveComment, {
          params: { id: c.id },
          body: { resolved },
        });
        replace(comment);
      } catch (err) {
        fail(err);
      }
    },
    [patch, replace, fail, displayName],
  );

  const react = useCallback(
    async (c: CommentReply, emoji: ReactionEmoji, active: boolean): Promise<void> => {
      patch((list) =>
        mapComment(list, c.id, (x) => {
          const cur = x.reactions.find((r) => r.emoji === emoji);
          const others = x.reactions.filter((r) => r.emoji !== emoji);
          if (active) {
            if (cur?.mine) return x;
            return {
              ...x,
              reactions: cur
                ? x.reactions.map((r) =>
                    r.emoji === emoji ? { ...r, count: r.count + 1, mine: true } : r,
                  )
                : [...x.reactions, { emoji, count: 1, mine: true }],
            };
          }
          if (!cur?.mine) return x;
          return {
            ...x,
            reactions:
              cur.count <= 1
                ? others
                : x.reactions.map((r) =>
                    r.emoji === emoji ? { ...r, count: r.count - 1, mine: false } : r,
                  ),
          };
        }),
      );
      try {
        const { comment } = await api(setCommentReaction, {
          params: { id: c.id },
          body: { emoji, active },
        });
        replace(comment);
      } catch (err) {
        fail(err);
      }
    },
    [patch, replace, fail],
  );

  const remove = useCallback(
    async (c: CommentReply): Promise<void> => {
      patch((list) =>
        c.parentId !== null
          ? list.map((x) =>
              x.id === c.parentId ? { ...x, replies: x.replies.filter((r) => r.id !== c.id) } : x,
            )
          : list.flatMap((x) =>
              x.id !== c.id
                ? [x]
                : x.replies.length > 0
                  ? [{ ...x, deleted: true, body: "", reactions: [] }]
                  : [],
            ),
      );
      try {
        await api(deleteComment, { params: { id: c.id } });
      } catch (err) {
        fail(err);
        return;
      }
      const id = `comment-undo-${c.id}`;
      const undo = async () => {
        notifications.hide(id);
        try {
          await api(restoreComment, { params: { id: c.id } });
          refresh();
        } catch (err) {
          fail(err);
        }
      };
      notifications.show({
        id,
        autoClose: UNDO_MS,
        message: (
          <Group justify="space-between" wrap="nowrap" gap="sm">
            <Text size="sm">{t("comments.deleted")}</Text>
            <Button
              size="sm"
              variant="light"
              h={44}
              onClick={() => void undo()}
              data-testid="comment-undo"
            >
              {t("markers.undo")}
            </Button>
          </Group>
        ),
      });
      refresh();
    },
    [patch, refresh, fail, t],
  );

  return { create, edit, move, resolve, react, remove };
}
