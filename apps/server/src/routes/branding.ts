import { getSetting, instanceLogo, instanceLogoHash, setSetting } from "@bandroom/server-core";
import { adminRemoveLogo } from "@bandroom/shared";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context";
import { audit } from "../http/audit";
import { sendBlob } from "../http/blobs";
import { registerAuthorizedRoute, registerContract } from "../http/contracts";
import { AppError } from "../http/errors";

/**
 * Branding logo (SPEC §25.1). The logo is public like the instance name: the login page and
 * public link pages show it too. Only the hash of the logo in use is served, so the route
 * never exposes other blobs.
 */
export function registerBrandingRoutes(api: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  registerAuthorizedRoute(
    api,
    { method: ["GET", "HEAD"], url: "/branding/logo/:hash", auth: { public: true } },
    (request, reply) => {
      const { hash } = request.params as { hash: string };
      if (hash !== instanceLogoHash(db)) throw new AppError("NOT_FOUND", "Logo not found");
      // Content-addressed: the URL changes with the logo, so it can be cached for good.
      return sendBlob(
        ctx,
        request,
        reply,
        hash,
        "image/webp",
        undefined,
        "public, max-age=31536000, immutable",
      );
    },
  );

  registerContract(api, adminRemoveLogo, (_input, request) => {
    const before = getSetting(db, "branding.logoAssetId");
    db.transaction(() => {
      setSetting(db, "branding.logoAssetId", null);
      setSetting(db, "branding.logoPendingAssetId", null);
      audit(db, request, {
        action: "settings.changed",
        targetType: "settings",
        details: {
          changes: ["logo"],
          before: { logoAssetId: before },
          after: { logoAssetId: null },
        },
      });
    });
    return { logo: instanceLogo(db) };
  });
}
