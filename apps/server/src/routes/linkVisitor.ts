import {
  blobReferrers,
  captureCommentContext,
  commentById,
  createCommentRow,
  createLinkSession,
  getCommentRow,
  getSongRow,
  getTrackRow,
  linkCoversBlob,
  linkListenSource,
  linkSong,
  linkSongs,
  linkTrack,
  linkVisibleTracks,
  linkVisibleVersionSet,
  linkVisibleVersions,
  listMarkers,
  listSongComments as listSongCommentRows,
  parseTimeCursor,
  projectImageHash,
  setLinkSessionName,
  signLinkSession,
  songTempo,
  songTimelineRev,
  songLockOf,
  toSong,
  toSongSummary,
  verifyPassword,
  verifyAgainstDummy,
  LINK_SESSION_TTL_MS,
  type LinkSessionRow,
  type SongRow,
} from "@bandroom/server-core";
import {
  COMMENTS_PAGE_MAX,
  createComment,
  DownloadQuerySchema,
  effectiveDownloadPolicy,
  linkCanDownload,
  getProjectQueue,
  getSong,
  getSongListen,
  getSongTempo,
  linkCapabilities,
  linkShowsComment,
  listMentionableUsers,
  listProjectSongs,
  listSongComments,
  listSongMarkers,
  listSongTracks,
  listTrackVersions,
  openLink,
  PaletteColorSchema,
  recordLinkPlay,
  setLinkVisitorName,
  unlockLink,
  type Access,
  type Comment,
  type CommentReply,
  type LinkView,
} from "@bandroom/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../context";
import { AppError } from "../http/errors";
import {
  LINK_COOKIE,
  linkAudit,
  linkCookiePath,
  linkDownloadAllowed,
  registerLinkContract,
  registerLinkRoute,
  type LinkAccess,
  type LinkPrincipal,
} from "../http/linkAuth";
import { AccessCache, CONTENT_TYPES, DOWNLOAD_RATE_LIMIT, sendBlob } from "../http/blobs";
import { BoundedRecent } from "../http/boundedRecent";
import { sendVersionDownload } from "../http/versionDownload";
import { notifyLinkComment, notifyLinkPasswordFailed } from "../notify";
import { toListenSource, toTrack, toTrackVersion } from "./trackDto";

/** One `link.played` per visitor and song within this window (bounded, in memory). */
const PLAY_DEDUPE_MS = 10 * 60_000;
const PLAY_DEDUPE_MAX = 5000;

/**
 * A comment as a link visitor may see it (review L6): the context keeps only tracks and versions
 * the link shows, and a comment on a hidden track loses its track id.
 */
function redactForLink<C extends CommentReply>(c: C, visible: Map<string, Set<string>>): C {
  const trackVersions: Record<string, string> = {};
  for (const [trackId, versionId] of Object.entries(c.context.trackVersions)) {
    if (visible.get(trackId)?.has(versionId)) trackVersions[trackId] = versionId;
  }
  const trackId = c.trackId !== null && visible.has(c.trackId) ? c.trackId : null;
  return { ...c, trackId, context: { ...c.context, trackVersions } };
}

function redactThread(c: Comment, visible: Map<string, Set<string>>): Comment {
  return { ...redactForLink(c, visible), replies: c.replies.map((r) => redactForLink(r, visible)) };
}
/** The per-link lockout ignores the IP (the per-IP throttle handles backoff). */
const LOCKOUT_IP = "*";

/**
 * What public-link visitors can call (SPEC §3.5, §11.2), under `/l/:linkToken`. Reads reuse the
 * logged-in app's contracts so the link view renders with the song page's components; every
 * response is filtered to what the link shows. Authorization happens in `http/linkAuth.ts`.
 */
export function registerLinkVisitorRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const blobCache = new AccessCache();
  const plays = new BoundedRecent(PLAY_DEDUPE_MS, PLAY_DEDUPE_MAX, true);

  const startSession = (
    request: FastifyRequest,
    reply: FastifyReply,
    p: LinkPrincipal,
    details: Record<string, unknown>,
  ): LinkSessionRow => {
    const session = createLinkSession(db, p.link.id, {
      ip: request.ip,
      userAgent: request.headers["user-agent"] ?? null,
    });
    reply.setCookie(LINK_COOKIE, signLinkSession(ctx.config.appSecret, p.link.id, session.id), {
      path: linkCookiePath(ctx, p.token),
      httpOnly: true,
      secure: ctx.cookies.secure,
      sameSite: "lax",
      maxAge: Math.floor(LINK_SESSION_TTL_MS / 1000),
    });
    linkAudit(ctx, request, { link: p.link, session }, { action: "link.opened", details });
    return session;
  };

  const viewOf = (p: LinkPrincipal, session: LinkSessionRow): LinkView => {
    const color = PaletteColorSchema.safeParse(p.project.color);
    const song = p.link.songId ? linkSong(db, p.link, p.link.songId) : undefined;
    return {
      scopeType: p.link.scopeType,
      content: p.link.content,
      versions: p.link.versions,
      allowComments: p.link.allowComments,
      showComments: p.link.showComments,
      allowDownload: linkCanDownload(
        p.policy,
        effectiveDownloadPolicy(song?.downloadPolicy ?? null, p.project.downloadPolicy),
      ),
      expiresAt: p.link.expiresAt,
      project: {
        id: p.project.id,
        name: p.project.name,
        color: color.success ? color.data : "violet",
        imageHash: projectImageHash(db, p.project),
      },
      songId: p.link.songId,
      visitor: { name: session.anonymousName },
    };
  };

  /** What the visitor may do in a song: at most commenter, downloads per link and policy. */
  const accessIn = (a: LinkAccess, song: SongRow): Access => ({
    role: a.role,
    capabilities: linkCapabilities(a.policy).filter(
      (c) => c !== "download" || linkDownloadAllowed(a, song),
    ),
  });
  const songOf = (a: LinkAccess): SongRow => {
    if (!a.song) throw new AppError("NOT_FOUND", "Not found");
    return a.song;
  };

  // ——— session ——————————————————————————————————————————————————————————————————————

  registerLinkContract(
    app,
    ctx,
    openLink,
    ({ access }, request, reply) => {
      if (access.session) return { state: "open" as const, view: viewOf(access, access.session) };
      if (access.link.passwordHash !== null) return { state: "password" as const };
      const session = startSession(request, reply, access, {});
      return { state: "open" as const, view: viewOf(access, session) };
    },
    // Each cookie-less open creates a session row and an event; maintenance purges expired
    // unnamed sessions (review M5).
    { rateLimit: { max: 60, timeWindow: "1 minute" } },
  );

  registerLinkContract(
    app,
    ctx,
    unlockLink,
    async ({ access, body }, request, reply) => {
      const { link } = access;
      const key = `${link.id}|${request.ip}`;
      // The per-link lockout catches guessing spread over many IPs; it is not reset by a success.
      const wait = Math.max(
        ctx.linkThrottle.retryAfterMs(key, request.ip),
        ctx.linkLockout.retryAfterMs(link.id, LOCKOUT_IP),
      );
      if (wait > 0) {
        throw new AppError("RATE_LIMITED", "Too many attempts", {
          retryAfterSec: Math.ceil(wait / 1000),
        });
      }
      const ok =
        link.passwordHash === null
          ? await verifyAgainstDummy(body.password).then(() => true)
          : await verifyPassword(link.passwordHash, body.password);
      if (!ok) {
        ctx.linkThrottle.recordFailure(key, request.ip);
        ctx.linkLockout.recordFailure(link.id, LOCKOUT_IP);
        linkAudit(ctx, request, access, { action: "link.password_failed" });
        notifyLinkPasswordFailed(ctx, {
          link,
          project: access.project,
          song: link.songId ? (linkSong(db, link, link.songId) ?? null) : null,
        });
        throw new AppError("WRONG_PASSWORD", "Wrong password");
      }
      ctx.linkThrottle.recordSuccess(key);
      const session = access.session ?? startSession(request, reply, access, { unlocked: true });
      return { view: viewOf(access, session) };
    },
    { rateLimit: { max: 20, timeWindow: "15 minutes" } },
  );

  registerLinkContract(
    app,
    ctx,
    setLinkVisitorName,
    ({ access, body }, request) => {
      const session = access.session as LinkSessionRow;
      if (session.anonymousName !== body.name) {
        setLinkSessionName(db, session.id, body.name);
        linkAudit(ctx, request, access, {
          action: "link.visitor_named",
          targetType: "linkSession",
          targetId: session.id,
          details: { name: body.name },
        });
      }
      return { ok: true as const };
    },
    // Each rename writes an event.
    { rateLimit: { max: 10, timeWindow: "1 minute" } },
  );

  registerLinkContract(
    app,
    ctx,
    recordLinkPlay,
    ({ access, body }, request) => {
      const song = songOf(access);
      const key = `${access.session?.id ?? ""}:${song.id}`;
      const now = Date.now();
      if (plays.markIfNew(key, now)) {
        linkAudit(ctx, request, access, {
          action: "link.played",
          songId: song.id,
          targetType: "song",
          targetId: song.id,
          details: { mode: body.mode },
        });
      }
      return { ok: true as const };
    },
    { rateLimit: { max: 60, timeWindow: "1 minute" } },
  );

  // ——— project ——————————————————————————————————————————————————————————————————————

  registerLinkContract(app, ctx, listProjectSongs, ({ access }) => ({
    songs: linkSongs(db, access.link).map((s) => ({
      ...toSongSummary(s, access.role),
      access: accessIn(access, s),
    })),
  }));

  registerLinkContract(app, ctx, getProjectQueue, ({ access }) => ({
    items: linkSongs(db, access.link).map((song) => {
      const src = linkListenSource(db, access.link, song.id);
      return {
        songId: song.id,
        title: song.title,
        subtitle: song.subtitle,
        listen: src ? toListenSource(src.details, src.isAutoMix) : null,
      };
    }),
  }));

  // ——— song ———————————————————————————————————————————————————————————————————————————

  registerLinkContract(app, ctx, getSong, ({ access }) => {
    const song = songOf(access);
    // Song notes are the band's internal notes: not shown through links.
    return {
      song: {
        ...toSong(
          song,
          access.project,
          access.role,
          projectImageHash(db, access.project),
          // Visitors see that the song is locked, not who locked it.
          songLockOf(db, song, false),
        ),
        notes: "",
        access: accessIn(access, song),
      },
    };
  });

  registerLinkContract(app, ctx, listSongTracks, ({ access }) => {
    const song = songOf(access);
    const allow = linkDownloadAllowed(access, song);
    return {
      tracks: linkVisibleTracks(db, access.link, song.id).map((t) => toTrack(t, allow)),
    };
  });

  registerLinkContract(app, ctx, listTrackVersions, ({ access }) => {
    const song = songOf(access);
    const track = access.targetId ? getTrackRow(db, access.targetId) : undefined;
    if (!track) throw new AppError("NOT_FOUND", "Track not found");
    const visible = linkVisibleVersions(db, access.link, track);
    const current =
      visible.find((v) => v.version.id === track.currentVersionId)?.version.id ??
      visible[0]?.version.id;
    const allow = linkDownloadAllowed(access, song);
    return {
      versions: visible.map((v) => ({
        ...toTrackVersion(v, allow),
        isCurrent: v.version.id === current,
      })),
    };
  });

  registerLinkContract(app, ctx, getSongListen, ({ access }) => {
    const src = linkListenSource(db, access.link, songOf(access).id);
    return { listen: src ? toListenSource(src.details, src.isAutoMix) : null };
  });

  registerLinkContract(app, ctx, listSongMarkers, ({ access }) => ({
    markers: listMarkers(db, songOf(access).id),
    timelineRev: songTimelineRev(db, songOf(access).id),
  }));

  registerLinkContract(app, ctx, getSongTempo, ({ access }) => ({
    tempo: songTempo(db, songOf(access).id),
    timelineRev: songTimelineRev(db, songOf(access).id),
  }));

  // ——— comments ———————————————————————————————————————————————————————————————————————

  const onlyLink = (a: LinkAccess) => (a.policy.showComments ? undefined : a.link.id);

  registerLinkContract(app, ctx, listSongComments, ({ access, query }) => {
    const cursor = parseTimeCursor(query.cursor);
    if (query.cursor && !cursor) throw new AppError("BAD_REQUEST", "Invalid cursor");
    const songId = songOf(access).id;
    const page = listSongCommentRows(db, songId, "", {
      cursor,
      limit: query.limit ?? COMMENTS_PAGE_MAX,
      onlyLinkId: onlyLink(access),
    });
    const visible = linkVisibleVersionSet(db, access.link, songId);
    return { ...page, comments: page.comments.map((c) => redactThread(c, visible)) };
  });

  registerLinkContract(
    app,
    ctx,
    createComment,
    ({ access, body }, request) => {
      const song = songOf(access);
      const session = access.session as LinkSessionRow;
      const name = session.anonymousName;
      if (!name) throw new AppError("LINK_NAME_REQUIRED", "Enter your name first");
      let parentId: string | null = null;
      let parentStart: number | null = null;
      if (body.parentId) {
        const p = getCommentRow(db, body.parentId);
        const top = p?.parentId ? getCommentRow(db, p.parentId) : p;
        if (
          !top ||
          top.songId !== song.id ||
          top.deletedAt !== null ||
          !linkShowsComment(access.policy, access.link.id, top)
        )
          throw new AppError("NOT_FOUND", "Comment not found");
        parentId = top.id;
        parentStart = top.startSec;
      }
      const trackId = parentId ? null : (body.trackId ?? null);
      if (trackId && linkTrack(db, access.link, trackId)?.song.id !== song.id)
        throw new AppError("BAD_REQUEST", "Unknown track");
      const row = createCommentRow(db, {
        songId: song.id,
        authorUserId: null,
        linkId: access.link.id,
        anonymousName: name,
        body: body.body,
        startSec: parentId ? null : (body.startSec ?? null),
        endSec: parentId ? null : (body.endSec ?? null),
        trackId,
        parentId,
        context: captureCommentContext(db, song.id, body.context?.trackVersions),
      });
      linkAudit(ctx, request, access, {
        action: "comment.created",
        songId: song.id,
        targetType: "comment",
        targetId: row.id,
        details: { parentId, startSec: row.startSec, endSec: row.endSec, trackId },
      });
      ctx.hub.publish({
        type: "comment.changed",
        projectId: access.project.id,
        songId: song.id,
        data: { commentId: row.id, parentId, action: "comment.created" },
      });
      notifyLinkComment(ctx, {
        link: access.link,
        project: access.project,
        song,
        visitorName: name,
        comment: { id: row.id, body: row.body, startSec: parentStart ?? row.startSec },
      });
      const comment = commentById(db, row.id, "", onlyLink(access));
      if (!comment) throw new AppError("INTERNAL", "Comment vanished");
      return { comment: redactThread(comment, linkVisibleVersionSet(db, access.link, song.id)) };
    },
    { rateLimit: { max: 10, timeWindow: "1 minute" } },
  );

  // Visitors never see who else is in the band.
  registerLinkContract(app, ctx, listMentionableUsers, () => ({ users: [] }));

  // ——— media ——————————————————————————————————————————————————————————————————————————

  registerLinkRoute(
    app,
    ctx,
    { method: ["GET", "HEAD"], url: "/blobs/:hash", auth: { capability: "stream", scope: "link" } },
    (request, reply, access) => {
      const { hash } = request.params as { hash: string };
      if (!/^[0-9a-f]{64}$/.test(hash)) throw new AppError("NOT_FOUND", "Blob not found");
      const now = Date.now();
      const key = `${access.session?.id ?? ""}:${hash}`;
      let variant: string | null = null;
      if (!blobCache.has(key, now)) {
        variant = linkCoversBlob(db, access.link, hash, (songId) => {
          const song = getSongRow(db, songId);
          return song !== undefined && linkDownloadAllowed(access, song);
        });
        if (variant === null) throw new AppError("NOT_FOUND", "Blob not found");
        blobCache.add(key, now);
      }
      variant ??= blobReferrers(db, hash)[0]?.variant ?? null;
      return sendBlob(
        ctx,
        request,
        reply,
        hash,
        (variant && CONTENT_TYPES[variant]) ?? "application/octet-stream",
      );
    },
  );

  registerLinkRoute(
    app,
    ctx,
    {
      method: "GET",
      url: "/track-versions/:id/download",
      auth: { capability: "download", scope: "trackVersion" },
    },
    (request, reply, access) => {
      const { format } = DownloadQuerySchema.parse(request.query);
      const song = songOf(access);
      const versionId = access.targetId ?? "";
      return sendVersionDownload(ctx, request, reply, versionId, format, (bytes) => {
        linkAudit(ctx, request, access, {
          action: "asset.downloaded",
          songId: song.id,
          targetType: "trackVersion",
          targetId: versionId,
          details: { format, bytes, viaLink: true },
        });
      });
    },
    { rateLimit: DOWNLOAD_RATE_LIMIT },
  );
}
