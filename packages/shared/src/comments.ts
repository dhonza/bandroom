import { z } from "zod";

/** Time-coded comments (SPEC §8). */
export const COMMENT_BODY_MAX = 5000;

/** The fixed reaction set; the "picker" offers exactly these (SPEC §8, DECISIONS M8). */
export const REACTION_EMOJIS = ["👍", "❤️", "😂", "🔥", "👏", "🎸", "🤔", "👀"] as const;
export const ReactionEmojiSchema = z.enum(REACTION_EMOJIS);
export type ReactionEmoji = z.infer<typeof ReactionEmojiSchema>;

export const CommentBodySchema = z.string().trim().min(1).max(COMMENT_BODY_MAX);
/** Song positions in seconds (same range as markers). */
export const CommentSecSchema = z.number().min(0).max(86_400);

/**
 * What was loaded when the comment was written (SPEC §8 context): the version of every track and
 * the tempo map revision. Parsed leniently on read (imported comments have no tempoRev).
 */
export const CommentContextSchema = z.object({
  trackVersions: z.record(z.string(), z.string()).default({}),
  tempoRev: z.string().nullable().default(null),
});
export type CommentContext = z.infer<typeof CommentContextSchema>;

export function parseCommentContext(json: string): CommentContext {
  try {
    const parsed = CommentContextSchema.safeParse(JSON.parse(json));
    if (parsed.success) return parsed.data;
  } catch {
    // fall through
  }
  return { trackVersions: {}, tempoRev: null };
}

/**
 * `user` = a local account; `imported` = an imported author without a local account, shown as
 * "Name (imported)"; `link` = a public-link visitor (M10); `deleted` = the account is gone.
 */
export const CommentAuthorSchema = z.object({
  userId: z.string().nullable(),
  name: z.string(),
  username: z.string().nullable(),
  kind: z.enum(["user", "imported", "link", "deleted"]),
});
export type CommentAuthor = z.infer<typeof CommentAuthorSchema>;

export const CommentReactionSchema = z.object({
  emoji: z.string(),
  count: z.number().int(),
  mine: z.boolean(),
});
export type CommentReaction = z.infer<typeof CommentReactionSchema>;

const CommentBaseSchema = z.object({
  id: z.string(),
  songId: z.string(),
  /** Null = the whole song. */
  trackId: z.string().nullable(),
  parentId: z.string().nullable(),
  author: CommentAuthorSchema,
  /** Markdown subset; empty for a deleted comment kept for its replies. */
  body: z.string(),
  /** Null = general comment; endSec null = point comment. */
  startSec: z.number().nullable(),
  endSec: z.number().nullable(),
  context: CommentContextSchema,
  source: z.enum(["app", "link", "import"]),
  resolvedAt: z.number().nullable(),
  resolvedByName: z.string().nullable(),
  createdAt: z.number(),
  editedAt: z.number().nullable(),
  /** A deleted comment that still has replies ("deleted comment"). */
  deleted: z.boolean(),
  reactions: z.array(CommentReactionSchema),
  /** Mentioned user ids. */
  mentions: z.array(z.string()),
});

export const CommentReplySchema = CommentBaseSchema;
export type CommentReply = z.infer<typeof CommentReplySchema>;

/** Top-level comment with its replies (one level, oldest first). */
export const CommentSchema = CommentBaseSchema.extend({ replies: z.array(CommentReplySchema) });
export type Comment = z.infer<typeof CommentSchema>;

export const CreateCommentSchema = z
  .object({
    body: CommentBodySchema,
    startSec: CommentSecSchema.nullable().optional(),
    endSec: CommentSecSchema.nullable().optional(),
    trackId: z.string().min(1).max(64).nullable().optional(),
    /** Reply to this comment (a reply to a reply attaches to its top-level comment). */
    parentId: z.string().min(1).max(64).nullable().optional(),
    /** Versions loaded in the player; the server fills in the current ones for missing tracks. */
    context: z
      .object({ trackVersions: z.record(z.string().max(64), z.string().max(64)) })
      .optional(),
    /** Client idempotency key (SPEC §18.3): a replay returns the first response. */
    requestId: z.uuid().optional(),
  })
  .refine((c) => c.endSec == null || (c.startSec != null && c.endSec > c.startSec), {
    message: "A range ends after it starts",
    path: ["endSec"],
  });
export type CreateComment = z.input<typeof CreateCommentSchema>;

/**
 * Editing the text and/or moving a comment. `startSec: null` makes it a general comment (its end
 * goes too), `endSec: null` a point comment. Replies have no times; the server checks the
 * resulting range against the stored one.
 */
export const UpdateCommentSchema = z
  .object({
    body: CommentBodySchema,
    startSec: CommentSecSchema.nullable(),
    endSec: CommentSecSchema.nullable(),
  })
  .partial()
  .refine((c) => c.body !== undefined || c.startSec !== undefined || c.endSec !== undefined, {
    message: "Nothing to change",
  })
  .refine(
    (c) =>
      c.endSec == null ||
      c.startSec === undefined ||
      (c.startSec !== null && c.endSec > c.startSec),
    {
      message: "A range ends after it starts",
      path: ["endSec"],
    },
  );
export type UpdateComment = z.infer<typeof UpdateCommentSchema>;

/** A user who can view the song, for `@` autocomplete (SPEC §8). */
export const MentionableUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
});
export type MentionableUser = z.infer<typeof MentionableUserSchema>;

/** `@username` tokens (SPEC §8): the same characters as usernames, case-insensitive. */
const MENTION_RE = /(^|[^a-z0-9._@-])@([a-z0-9][a-z0-9._-]{1,31})/gi;

/** Usernames mentioned in a body (lowercase, unique, in order), trailing dots dropped. */
export function extractMentions(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(MENTION_RE)) {
    const name = (m[2] ?? "").toLowerCase().replace(/[.]+$/, "");
    if (name.length >= 3 && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Splits text into plain parts and mention parts (for rendering highlighted mentions). */
export function splitMentions(
  text: string,
  known: ReadonlySet<string>,
): { text: string; mention: boolean }[] {
  const parts: { text: string; mention: boolean }[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION_RE)) {
    const lead = m[1] ?? "";
    const name = (m[2] ?? "").replace(/[.]+$/, "");
    if (!known.has(name.toLowerCase())) continue;
    const at = m.index + lead.length;
    if (at > last) parts.push({ text: text.slice(last, at), mention: false });
    parts.push({ text: `@${name}`, mention: true });
    last = at + name.length + 1;
  }
  if (last < text.length) parts.push({ text: text.slice(last), mention: false });
  return parts;
}

/** The `@` token being typed at the caret, for autocomplete; null when not in a mention. */
export function mentionQueryAt(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|[^a-z0-9._@-])@([a-z0-9._-]{0,32})$/i.exec(before);
  if (!m) return null;
  const query = m[2] ?? "";
  return { start: caret - query.length - 1, query: query.toLowerCase() };
}

// Moved out; still reachable from here for existing importers.
export * from "./commentExport";
export * from "./notifications";
