import {
  PALETTE_COLORS,
  type Comment,
  type CommentAuthor,
  type PaletteColor,
} from "@bandroom/shared";
import type { ComposerDraft } from "./store";

/** Panel filters (SPEC §8): open/resolved, author, track, "mentions me". */
export interface CommentFilters {
  showResolved: boolean;
  /** `user:<id>` or `name:<imported name>`; null = everyone. */
  author: string | null;
  /** Track id, `song` for song-wide comments, or null = all. */
  track: string | null;
  mentionsMe: boolean;
}

export type CommentSort = "time" | "date";

export const DEFAULT_FILTERS: CommentFilters = {
  showResolved: false,
  author: null,
  track: null,
  mentionsMe: false,
};

export function authorKey(a: CommentAuthor): string {
  return a.userId ? `user:${a.userId}` : `name:${a.name}`;
}

export function isResolved(c: Comment): boolean {
  return c.resolvedAt !== null;
}

/** Whether a comment (or one of its replies) mentions the user. */
export function mentions(c: Comment, userId: string): boolean {
  return c.mentions.includes(userId) || c.replies.some((r) => r.mentions.includes(userId));
}

export function filterComments(
  comments: readonly Comment[],
  f: CommentFilters,
  userId: string,
): Comment[] {
  return comments.filter(
    (c) =>
      (f.showResolved || !isResolved(c)) &&
      (f.author === null ||
        authorKey(c.author) === f.author ||
        c.replies.some((r) => authorKey(r.author) === f.author)) &&
      (f.track === null || (f.track === "song" ? c.trackId === null : c.trackId === f.track)) &&
      (!f.mentionsMe || mentions(c, userId)),
  );
}

/** Time in song (general comments first), or newest activity first. */
export function sortComments(comments: readonly Comment[], sort: CommentSort): Comment[] {
  const lastActivity = (c: Comment) => Math.max(c.createdAt, ...c.replies.map((r) => r.createdAt));
  return [...comments].sort((a, b) =>
    sort === "time"
      ? (a.startSec ?? -1) - (b.startSec ?? -1) || a.createdAt - b.createdAt
      : lastActivity(b) - lastActivity(a),
  );
}

/** Distinct authors (with replies) for the author filter. */
export function authorsOf(comments: readonly Comment[]): { key: string; name: string }[] {
  const out = new Map<string, string>();
  for (const c of comments) {
    for (const a of [c.author, ...c.replies.map((r) => r.author)]) {
      if (a.kind !== "deleted") out.set(authorKey(a), a.name);
    }
  }
  return [...out]
    .map(([key, name]) => ({ key, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Stable author color from the palette ("author avatar colors", SPEC §8). */
export function authorColor(a: CommentAuthor): PaletteColor {
  const key = authorKey(a);
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return PALETTE_COLORS[Math.abs(h) % PALETTE_COLORS.length] ?? "blue";
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "?";
  const second = parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "";
  return `${first}${second}`.toUpperCase();
}

/**
 * Tracks whose version when the comment was written differs from the one loaded now (SPEC §8
 * "written on Bass v3"). Tracks missing on either side are ignored.
 */
export function contextDiff(
  context: Comment["context"],
  loaded: Readonly<Record<string, string>>,
): { trackId: string; versionId: string }[] {
  return Object.entries(context.trackVersions)
    .filter(
      ([trackId, versionId]) => loaded[trackId] !== undefined && loaded[trackId] !== versionId,
    )
    .map(([trackId, versionId]) => ({ trackId, versionId }));
}

/** Comments with a position, for the timeline lane (resolved ones only when shown). */
export function laneComments(comments: readonly Comment[], showResolved: boolean): Comment[] {
  return comments.filter(
    (c) => c.startSec !== null && !c.deleted && (showResolved || !isResolved(c)),
  );
}

/** Number of visible comments (with replies) for the panel button. */
export function openCount(comments: readonly Comment[]): number {
  return comments.filter((c) => !c.deleted && !isResolved(c)).length;
}

/**
 * Usernames whose mentions are highlighted: every user who can view the song, or for viewers
 * (no user list) the comment and reply authors.
 */
export function mentionUsernames(
  users: readonly { username: string }[] | undefined,
  comments: readonly Comment[],
): string[] {
  return (
    users?.map((u) => u.username) ??
    comments.flatMap((c) =>
      [c.author, ...c.replies.map((r) => r.author)].flatMap((a) =>
        a.username ? [a.username] : [],
      ),
    )
  );
}

/** The new comment from the composer: its range when chosen, else its time (or none). */
export function composerPayload(
  draft: ComposerDraft,
  body: string,
  trackVersions: Record<string, string>,
) {
  const useRange = draft.range !== null && draft.useRange;
  return {
    body,
    startSec: useRange ? (draft.range?.start ?? null) : draft.startSec,
    endSec: useRange ? (draft.range?.end ?? null) : null,
    trackId: draft.trackId,
    context: { trackVersions },
  };
}
