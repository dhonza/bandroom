import {
  activeAdminIds,
  createNotifications,
  followerIds,
  followTarget,
  getTrackRow,
  getTrackVersionRow,
  getUsage,
  hasUnreadNotification,
  type NotifyInput,
  type ProjectRow,
  type SongRow,
  type UserRow,
} from "@bandroom/server-core";
import { commentExcerpt, type ContentRole } from "@bandroom/shared";
import type { AppContext } from "./context";
import { effectiveQuota } from "./quota";

type Ctx = Pick<AppContext, "db" | "hub">;

/**
 * Creates notifications through the single service (SPEC §16) and pushes each one to its
 * recipient over SSE (`notification`, user-targeted).
 */
export function notify(ctx: Ctx, input: NotifyInput): number {
  const created = createNotifications(ctx.db, input);
  for (const c of created) {
    ctx.hub.publish({
      type: "notification",
      userId: c.userId,
      data: { id: c.id, kind: input.type },
    });
  }
  return created.length;
}

const songPayload = (project: ProjectRow, song: SongRow) => ({
  projectId: project.id,
  projectName: project.name,
  songId: song.id,
  songTitle: song.title,
});

/** Project fields, plus the song's for song-level targets. */
const scopePayload = (project: ProjectRow, song: SongRow | null) => ({
  projectId: project.id,
  projectName: project.name,
  ...(song && { songId: song.id, songTitle: song.title }),
});

const commentFields = (comment: { id: string; body: string; startSec: number | null }) => ({
  commentId: comment.id,
  startSec: comment.startSec,
  excerpt: commentExcerpt(comment.body),
});

/**
 * A new comment or reply (SPEC §16): mentions, a reply to the parent's author, and the song's
 * uploaders for top-level comments ("comment on a song I uploaded to"). Each user gets one
 * notification, the most specific. The author auto-follows the song.
 */
export function notifyComment(
  ctx: Ctx,
  a: {
    actor: UserRow;
    project: ProjectRow;
    song: SongRow;
    comment: { id: string; body: string; startSec: number | null };
    mentioned: readonly string[];
    parentAuthorId: string | null;
    uploaderIds: readonly string[];
  },
): void {
  const payload = {
    ...songPayload(a.project, a.song),
    actorName: a.actor.displayName,
    ...commentFields(a.comment),
  };
  const common = { actorId: a.actor.id, payload, projectId: a.project.id, songId: a.song.id };
  const done = new Set<string>([a.actor.id]);
  const send = (type: NotifyInput["type"], ids: readonly string[]) => {
    const todo = ids.filter((id) => !done.has(id));
    todo.forEach((id) => done.add(id));
    if (todo.length > 0) notify(ctx, { ...common, type, userIds: todo });
  };
  send("mention", a.mentioned);
  if (a.parentAuthorId) send("reply", [a.parentAuthorId]);
  else send("comment_on_upload", a.uploaderIds);
  followTarget(ctx.db, a.actor.id, "song", a.song.id);
}

/** Mentions added by an edit notify only the newly mentioned users. */
export function notifyEditMentions(
  ctx: Ctx,
  a: {
    actor: UserRow;
    project: ProjectRow;
    song: SongRow;
    comment: { id: string; body: string; startSec: number | null };
    mentioned: readonly string[];
  },
): void {
  if (a.mentioned.length === 0) return;
  notify(ctx, {
    type: "mention",
    userIds: a.mentioned,
    actorId: a.actor.id,
    projectId: a.project.id,
    songId: a.song.id,
    payload: {
      ...songPayload(a.project, a.song),
      actorName: a.actor.displayName,
      ...commentFields(a.comment),
    },
  });
}

/** A new version (or a new track's first version): the song's followers; the uploader follows. */
export function notifyVersionUploaded(
  ctx: Ctx,
  a: { actor: UserRow; project: ProjectRow; song: SongRow; versionId: string },
): void {
  const version = getTrackVersionRow(ctx.db, a.versionId);
  const track = version && getTrackRow(ctx.db, version.trackId);
  followTarget(ctx.db, a.actor.id, "song", a.song.id);
  if (!version || !track || track.isSystem) return;
  notify(ctx, {
    type: "new_version",
    userIds: followerIds(ctx.db, "song", a.song.id),
    actorId: a.actor.id,
    projectId: a.project.id,
    songId: a.song.id,
    payload: {
      ...songPayload(a.project, a.song),
      actorName: a.actor.displayName,
      trackName: track.name,
      versionNumber: version.number,
    },
  });
}

/**
 * A new document or document version (SPEC §10, §16): followers of the song, or of the project
 * for project-level documents. Uploading to a song follows it, like track versions.
 */
export function notifyDocument(
  ctx: Ctx,
  a: {
    actor: UserRow;
    project: ProjectRow;
    song: SongRow | null;
    document: { id: string; title: string };
    version: { number: number };
  },
): void {
  if (a.song) followTarget(ctx.db, a.actor.id, "song", a.song.id);
  notify(ctx, {
    type: "new_document",
    userIds: a.song
      ? followerIds(ctx.db, "song", a.song.id)
      : followerIds(ctx.db, "project", a.project.id),
    actorId: a.actor.id,
    projectId: a.project.id,
    songId: a.song?.id ?? null,
    projectViewersOnly: a.song === null,
    payload: {
      ...scopePayload(a.project, a.song),
      actorName: a.actor.displayName,
      documentId: a.document.id,
      documentTitle: a.document.title,
      versionNumber: a.version.number,
    },
  });
}

/** A new song: the project's followers; the creator follows the song. */
export function notifyNewSong(
  ctx: Ctx,
  a: { actor: UserRow; project: ProjectRow; song: SongRow },
): void {
  followTarget(ctx.db, a.actor.id, "song", a.song.id);
  notify(ctx, {
    type: "new_song",
    userIds: followerIds(ctx.db, "project", a.project.id),
    actorId: a.actor.id,
    projectId: a.project.id,
    songId: a.song.id,
    payload: { ...songPayload(a.project, a.song), actorName: a.actor.displayName },
  });
}

/** "I was granted access" (SPEC §16): a grant that gives (other) access than before. */
export function notifyGranted(
  ctx: Ctx,
  a: {
    actor: UserRow;
    granteeId: string;
    project: ProjectRow;
    song: SongRow | null;
    before: ContentRole | null;
    after: ContentRole;
  },
): void {
  if (a.after === "none" || a.after === a.before) return;
  notify(ctx, {
    type: "granted",
    userIds: [a.granteeId],
    actorId: a.actor.id,
    projectId: a.project.id,
    songId: a.song?.id ?? null,
    payload: {
      ...scopePayload(a.project, a.song),
      actorName: a.actor.displayName,
      role: a.after,
    },
  });
}

export const QUOTA_WARNING_RATIO = 0.8;

/** Usage at or above 80 % of the quota: one unread warning at a time (SPEC §15.1, §16). */
export function notifyQuota(ctx: Ctx, user: UserRow, quota: number | null): void {
  if (quota === null || quota <= 0) return;
  const used = getUsage(ctx.db, user.id);
  if (used < quota * QUOTA_WARNING_RATIO) return;
  if (hasUnreadNotification(ctx.db, user.id, "quota_warning")) return;
  notify(ctx, {
    type: "quota_warning",
    userIds: [user.id],
    actorId: null,
    payload: { percent: Math.min(100, Math.round((used / quota) * 100)) },
  });
}

/** `notifyQuota` with the user's effective quota, after an upload or a document edit. */
export function notifyQuotaFor(ctx: Ctx, user: UserRow): void {
  notifyQuota(ctx, user, effectiveQuota(ctx, user));
}

/** "Ask admin" reset requests notify every admin, once per user while unread (M1 follow-up). */
export function notifyResetRequest(ctx: Ctx, requester: UserRow): void {
  const admins = activeAdminIds(ctx.db).filter(
    (id) => !hasUnreadNotification(ctx.db, id, "reset_request", requester.id),
  );
  if (admins.length === 0) return;
  notify(ctx, {
    type: "reset_request",
    userIds: admins,
    actorId: requester.id,
    payload: {
      actorName: requester.displayName,
      userId: requester.id,
      username: requester.username,
    },
  });
}

const linkPayload = (
  link: { id: string; label: string },
  project: ProjectRow,
  song: SongRow | null,
) => ({
  linkId: link.id,
  linkLabel: link.label,
  ...scopePayload(project, song),
});

/**
 * A wrong password on a public link tells the link's creator (M8 follow-up), at most one unread
 * notification per link so guessing cannot flood the inbox.
 */
export function notifyLinkPasswordFailed(
  ctx: Ctx,
  a: {
    link: { id: string; label: string; createdBy: string | null };
    project: ProjectRow;
    song: SongRow | null;
  },
): void {
  const owner = a.link.createdBy;
  if (!owner || hasUnreadNotification(ctx.db, owner, "link_password_failed", a.link.id, "linkId"))
    return;
  notify(ctx, {
    type: "link_password_failed",
    userIds: [owner],
    actorId: null,
    payload: linkPayload(a.link, a.project, a.song),
    projectId: a.project.id,
    songId: a.song?.id ?? null,
  });
}

/** A visitor commented through a link: its creator hears about it. */
export function notifyLinkComment(
  ctx: Ctx,
  a: {
    link: { id: string; label: string; createdBy: string | null };
    project: ProjectRow;
    song: SongRow;
    visitorName: string;
    comment: { id: string; body: string; startSec: number | null };
  },
): void {
  if (!a.link.createdBy) return;
  notify(ctx, {
    type: "link_comment",
    userIds: [a.link.createdBy],
    actorId: null,
    payload: {
      ...linkPayload(a.link, a.project, a.song),
      actorName: a.visitorName,
      ...commentFields(a.comment),
    },
    projectId: a.project.id,
    songId: a.song.id,
  });
}
