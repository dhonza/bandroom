import {
  createLinkRow,
  EMPTY_LINK_STATS,
  expireLinkSessions,
  getSongRow,
  hashPassword,
  linkRecentActivity,
  linkRowStatus,
  linkSongStats,
  linkStatsOf,
  linkTokenOf,
  listLinkRows,
  parseVersionIds,
  resolveSongAccess,
  revokeLinkRow,
  songIdOfTrackVersion,
  updateLinkRow,
  userDisplayNames,
  type LinkPatch,
  type LinkRow,
  type ProjectRow,
  type SongRow,
  type UserRow,
} from "@bandroom/server-core";
import {
  adminListLinks,
  canDownload,
  createProjectLink,
  createSongLink,
  effectiveDownloadPolicy,
  getLinkAnalytics,
  hasCapability,
  listProjectLinks,
  listSongLinks,
  revokeLink,
  updateLink,
  type CreateLinkSchema,
  type PublicLink,
} from "@bandroom/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { z } from "zod";
import { appLink, type AppContext } from "../context";
import { audit } from "../http/audit";
import { registerContract } from "../http/contracts";
import { AppError } from "../http/errors";

type Row = { link: LinkRow; project: ProjectRow; song: SongRow | null };

/** Short anonymous visitor id: the random tail of the link-session UUID. */
export function visitorTag(sessionId: string | null): string | null {
  return sessionId ? sessionId.replace(/-/g, "").slice(-6) : null;
}

/**
 * Public link management (SPEC §3.5): editors of the scope create, change, deactivate and revoke
 * links and see their analytics (SPEC §14.3); admins see every link instance-wide.
 */
export function registerLinkRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  const toDtos = (rows: readonly Row[]): PublicLink[] => {
    const stats = linkStatsOf(
      db,
      rows.map((r) => r.link.id),
    );
    const names = userDisplayNames(
      db,
      rows.flatMap((r) => (r.link.createdBy ? [r.link.createdBy] : [])),
    );
    const now = Date.now();
    return rows.map(({ link, project, song }) => ({
      id: link.id,
      url: appLink(ctx, `/l/${linkTokenOf(ctx.config.appSecret, link)}`),
      label: link.label,
      scopeType: link.scopeType,
      projectId: link.projectId,
      projectName: project.name,
      songId: link.songId,
      songTitle: song?.title ?? null,
      versionIds: parseVersionIds(link.versionIds),
      versions: link.versions,
      hasPassword: link.passwordHash !== null,
      expiresAt: link.expiresAt,
      active: link.active,
      revokedAt: link.revokedAt,
      status: linkRowStatus(link, now),
      allowDownload: link.allowDownload,
      downloadPolicyAllows: canDownload(
        "viewer",
        effectiveDownloadPolicy(song?.downloadPolicy ?? null, project.downloadPolicy),
      ),
      allowComments: link.allowComments,
      showComments: link.showComments,
      createdBy: link.createdBy,
      createdByName: link.createdBy ? (names.get(link.createdBy) ?? null) : null,
      createdAt: link.createdAt,
      updatedAt: link.updatedAt,
      stats: stats.get(link.id) ?? { ...EMPTY_LINK_STATS },
    }));
  };
  const one = (link: LinkRow): PublicLink => {
    const [row] = listLinkRows(db, { linkId: link.id });
    if (!row) throw new AppError("NOT_FOUND", "Link not found");
    return toDtos([row])[0] as PublicLink;
  };

  type LinkAction = "link.created" | "link.updated" | "link.revoked";
  /** The change's event; call inside the change's transaction. */
  const logged = (
    request: FastifyRequest,
    link: LinkRow,
    action: LinkAction,
    details: Record<string, unknown>,
  ) => {
    audit(db, request, {
      action,
      linkId: link.id,
      projectId: link.projectId,
      songId: link.songId,
      targetType: "link",
      targetId: link.id,
      details,
    });
  };
  /** Tells open clients, after the change committed. */
  const announce = (link: LinkRow, action: LinkAction) => {
    ctx.hub.publish({
      type: "link.changed",
      projectId: link.projectId,
      songId: link.songId,
      data: { linkId: link.id, action },
    });
  };

  const futureOrNull = (expiresAt: number | null | undefined) => {
    if (expiresAt != null && expiresAt <= Date.now())
      throw new AppError("BAD_REQUEST", "The expiry date must lie in the future");
  };

  const create = async (
    request: FastifyRequest,
    user: UserRow,
    body: z.output<typeof CreateLinkSchema>,
    project: ProjectRow,
    song: SongRow | null,
  ): Promise<{ link: PublicLink }> => {
    futureOrNull(body.expiresAt);
    let versionIds: string[] = [];
    if (body.scopeType === "versions") {
      versionIds = [...new Set(body.versionIds ?? [])];
      if (versionIds.length === 0) throw new AppError("BAD_REQUEST", "Pick at least one version");
      if (versionIds.some((id) => songIdOfTrackVersion(db, id) !== song?.id))
        throw new AppError("BAD_REQUEST", "Versions must belong to this song");
    }
    const passwordHash = body.password ? await hashPassword(body.password) : null;
    const row = db.transaction(() => {
      const { row } = createLinkRow(db, ctx.config.appSecret, {
        scopeType: body.scopeType,
        projectId: project.id,
        songId: song?.id ?? null,
        versionIds,
        // A versions link shows exactly its versions; `versions` does not apply.
        versions: body.scopeType === "versions" ? "all" : body.versions,
        passwordHash,
        expiresAt: body.expiresAt ?? null,
        allowDownload: body.allowDownload,
        allowComments: body.allowComments,
        showComments: body.showComments,
        label: body.label,
        createdBy: user.id,
      });
      logged(request, row, "link.created", {
        scopeType: row.scopeType,
        versions: row.versions,
        versionCount: versionIds.length,
        hasPassword: row.passwordHash !== null,
        expiresAt: row.expiresAt,
        allowDownload: row.allowDownload,
        allowComments: row.allowComments,
        showComments: row.showComments,
      });
      return row;
    });
    announce(row, "link.created");
    return { link: one(row) };
  };

  registerContract(app, listProjectLinks, ({ user, access }) => {
    // Song links count only where the caller manages that song (song grants may differ).
    const rows = listLinkRows(db, { projectId: access.project.id }).filter((r) => {
      if (!r.link.songId) return true;
      const a = resolveSongAccess(db, user, r.link.songId);
      return a !== undefined && hasCapability(a.role, "link.manage");
    });
    return { links: toDtos(rows) };
  });

  registerContract(app, createProjectLink, ({ body, user, access }, request) => {
    if (body.scopeType !== "project")
      throw new AppError("BAD_REQUEST", "Project links have scope 'project'");
    return create(request, user, { ...body, scopeType: "project" }, access.project, null);
  });

  registerContract(app, listSongLinks, ({ access }) => ({
    links: toDtos(listLinkRows(db, { songId: access.song.id })),
  }));

  registerContract(app, createSongLink, ({ body, user, access }, request) => {
    if (body.scopeType === "project")
      throw new AppError("BAD_REQUEST", "Song links have scope 'song' or 'versions'");
    return create(request, user, body, access.project, access.song);
  });

  registerContract(app, updateLink, async ({ body, access }, request) => {
    const link = access.link;
    if (link.revokedAt !== null) throw new AppError("BAD_REQUEST", "The link was revoked");
    futureOrNull(body.expiresAt);
    const patch: LinkPatch = {};
    for (const k of [
      "label",
      "expiresAt",
      "active",
      "allowDownload",
      "allowComments",
      "showComments",
    ] as const) {
      if (body[k] !== undefined) (patch as Record<string, unknown>)[k] = body[k];
    }
    if (link.scopeType !== "versions") {
      if (body.versions !== undefined) patch.versions = body.versions;
    }
    if (body.password !== undefined) {
      patch.passwordHash = body.password === null ? null : await hashPassword(body.password);
    }
    const updated = db.transaction(() => {
      const row = updateLinkRow(db, link.id, patch);
      // A new or removed password ends every visitor session: they must open the link again.
      if (body.password !== undefined) expireLinkSessions(db, link.id);
      logged(request, row, "link.updated", {
        changes: Object.keys(patch).map((k) => (k === "passwordHash" ? "password" : k)),
        ...(patch.active !== undefined && { active: patch.active }),
      });
      return row;
    });
    announce(updated, "link.updated");
    return { link: one(updated) };
  });

  registerContract(app, revokeLink, ({ access }, request) => {
    const wasRevoked = access.link.revokedAt !== null;
    const row = db.transaction(() => {
      const revoked = revokeLinkRow(db, access.link.id);
      if (!wasRevoked) logged(request, revoked, "link.revoked", {});
      return revoked;
    });
    if (!wasRevoked) announce(row, "link.revoked");
    return { link: one(row) };
  });

  registerContract(app, getLinkAnalytics, ({ access }) => {
    const link = access.link;
    const stats = linkStatsOf(db, [link.id]).get(link.id) ?? { ...EMPTY_LINK_STATS };
    const perSong = linkSongStats(db, link.id);
    const songs = [...perSong.entries()].flatMap(([songId, s]) => {
      const song = getSongRow(db, songId);
      return song ? [{ songId, title: song.title, ...s }] : [];
    });
    return {
      stats,
      songs,
      recent: linkRecentActivity(db, link.id).map((r) => ({
        id: r.id,
        ts: r.ts,
        action: r.action,
        visitor: visitorTag(r.linkSessionId),
        visitorName: r.visitorName,
        songId: r.songId,
        songTitle: r.songTitle,
        details: safeDetails(r.details),
      })),
    };
  });

  registerContract(app, adminListLinks, () => ({ links: toDtos(listLinkRows(db)) }));
}

function safeDetails(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const v: unknown = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
