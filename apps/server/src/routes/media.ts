import {
  blobReferrers,
  DOWNLOAD_ONLY_VARIANTS,
  resolveProjectAccess,
  resolveSongAccess,
  type UserRow,
} from "@bandroom/server-core";
import { DownloadQuerySchema, hasCapability, roleAtLeast } from "@bandroom/shared";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context";
import { audit } from "../http/audit";
import { AccessCache, CONTENT_TYPES, DOWNLOAD_RATE_LIMIT, sendBlob } from "../http/blobs";
import { registerAuthorizedRoute } from "../http/contracts";
import { AppError } from "../http/errors";
import { downloadAllowed, type SongScopeAccess } from "../http/scope";
import { sendVersionDownload } from "../http/versionDownload";

function canAccessBlob(
  ctx: AppContext,
  user: UserRow,
  hash: string,
): { ok: boolean; variant: string | null } {
  let variant: string | null = null;
  for (const r of blobReferrers(ctx.db, hash)) {
    variant ??= r.variant;
    if (r.kind === "song") {
      // Lossless variants count as "download" (SPEC §3.4); a deduplicated blob may still be
      // reachable through another referrer, so keep looking.
      const a = resolveSongAccess(ctx.db, user, r.songId);
      if (!a || !hasCapability(a.role, "stream")) continue;
      if (DOWNLOAD_ONLY_VARIANTS.has(r.variant) && !downloadAllowed(a)) continue;
      return { ok: true, variant: r.variant };
    } else if (r.kind === "songDocument") {
      const a = resolveSongAccess(ctx.db, user, r.songId);
      if (a && hasCapability(a.role, "stream")) return { ok: true, variant: r.variant };
    } else if (r.kind === "projectDocument") {
      const a = resolveProjectAccess(ctx.db, user, r.projectId);
      if (a && roleAtLeast(a.role, "viewer")) return { ok: true, variant: r.variant };
    } else {
      const a = resolveProjectAccess(ctx.db, user, r.projectId);
      if (a && a.visibility !== "hidden") return { ok: true, variant: r.variant };
    }
  }
  return { ok: false, variant };
}

export function registerMediaRoutes(api: FastifyInstance, ctx: AppContext): void {
  const cache = new AccessCache();

  registerAuthorizedRoute(
    api,
    { method: ["GET", "HEAD"], url: "/blobs/:hash", auth: { user: true } },
    async (request, reply) => {
      const { hash } = request.params as { hash: string };
      const user = request.user;
      if (!user || !/^[0-9a-f]{64}$/.test(hash)) throw new AppError("NOT_FOUND", "Blob not found");
      const now = Date.now();
      const key = `${request.session?.id ?? user.id}:${hash}`;
      let variant: string | null = null;
      if (!cache.has(key, now)) {
        const res = canAccessBlob(ctx, user, hash);
        if (!res.ok) throw new AppError("NOT_FOUND", "Blob not found");
        cache.add(key, now);
        variant = res.variant;
      }
      variant ??= blobReferrers(ctx.db, hash)[0]?.variant ?? null;
      return sendBlob(
        ctx,
        request,
        reply,
        hash,
        (variant && CONTENT_TYPES[variant]) ?? "application/octet-stream",
      );
    },
  );

  registerAuthorizedRoute(
    api,
    {
      method: "GET",
      url: "/track-versions/:id/download",
      auth: { capability: "download", scope: "trackVersion" },
    },
    async (request, reply) => {
      const access = request.access as SongScopeAccess;
      const { format } = DownloadQuerySchema.parse(request.query);
      return sendVersionDownload(ctx, request, reply, access.targetId, format, (bytes) => {
        audit(ctx.db, request, {
          action: "asset.downloaded",
          projectId: access.project.id,
          songId: access.song.id,
          targetType: "trackVersion",
          targetId: access.targetId,
          details: { format, bytes },
        });
      });
    },
    { rateLimit: DOWNLOAD_RATE_LIMIT },
  );
}
