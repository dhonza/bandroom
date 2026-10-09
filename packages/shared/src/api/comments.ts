import { z } from "zod";
import {
  CommentSchema,
  CreateCommentSchema,
  MentionableUserSchema,
  ReactionEmojiSchema,
  UpdateCommentSchema,
} from "../comments";
import { OkSchema } from "./auth";
import { defineContract } from "./contract";

const IdParams = z.object({ id: z.string().min(1).max(64) });

export const COMMENTS_PAGE_MAX = 200;

/**
 * Comments of a song (SPEC §8), top-level comments oldest first with their replies embedded.
 * Cursor pagination over top-level comments (SPEC §18.3).
 */
export const listSongComments = defineContract({
  method: "GET",
  path: "/songs/:id/comments",
  params: IdParams,
  query: z.object({
    cursor: z.string().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(COMMENTS_PAGE_MAX).optional(),
  }),
  response: z.object({ comments: z.array(CommentSchema), nextCursor: z.string().nullable() }),
  errors: ["BAD_REQUEST"],
  auth: { capability: "view", scope: "song" },
});

/** Commenters write comments and replies; the time is captured by the client (SPEC §8). */
export const createComment = defineContract({
  method: "POST",
  path: "/songs/:id/comments",
  params: IdParams,
  body: CreateCommentSchema,
  response: z.object({ comment: CommentSchema }),
  errors: ["BAD_REQUEST", "NOT_FOUND"],
  auth: { capability: "comment", scope: "song" },
});

/** Own comments with `comment`, anyone's with `annotate.any` (canActOnComment). */
export const updateComment = defineContract({
  method: "PATCH",
  path: "/comments/:id",
  params: IdParams,
  body: UpdateCommentSchema,
  response: z.object({ comment: CommentSchema }),
  errors: ["NOT_FOUND", "FORBIDDEN", "BAD_REQUEST"],
  auth: { capability: "comment", scope: "comment" },
});

/** Soft delete; replies stay under a "deleted comment" placeholder; undo for 8 s. */
export const deleteComment = defineContract({
  method: "DELETE",
  path: "/comments/:id",
  params: IdParams,
  response: OkSchema,
  errors: ["NOT_FOUND", "FORBIDDEN"],
  auth: { capability: "comment", scope: "comment" },
});

export const restoreComment = defineContract({
  method: "POST",
  path: "/comments/:id/restore",
  params: IdParams,
  response: z.object({ comment: CommentSchema }),
  errors: ["NOT_FOUND", "FORBIDDEN"],
  auth: { capability: "comment", scope: "comment" },
});

/** Resolve or reopen a top-level comment (SPEC §8). */
export const resolveComment = defineContract({
  method: "POST",
  path: "/comments/:id/resolve",
  params: IdParams,
  body: z.object({ resolved: z.boolean() }),
  response: z.object({ comment: CommentSchema }),
  errors: ["NOT_FOUND", "FORBIDDEN", "BAD_REQUEST"],
  auth: { capability: "comment", scope: "comment" },
});

/** Adds or removes the caller's reaction (idempotent). */
export const setCommentReaction = defineContract({
  method: "PUT",
  path: "/comments/:id/reactions",
  params: IdParams,
  body: z.object({ emoji: ReactionEmojiSchema, active: z.boolean() }),
  response: z.object({ comment: CommentSchema }),
  errors: ["NOT_FOUND"],
  auth: { capability: "comment", scope: "comment" },
});

/** Users who can view the song, for `@` autocomplete (SPEC §8). */
export const listMentionableUsers = defineContract({
  method: "GET",
  path: "/songs/:id/mentionable",
  params: IdParams,
  response: z.object({ users: z.array(MentionableUserSchema) }),
  auth: { capability: "comment", scope: "song" },
});
