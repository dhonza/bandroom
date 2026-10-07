import type { InstanceLogo } from "@bandroom/shared";
import { getAsset } from "../media/assets";
import { getVariant } from "../media/variants";
import type { Db } from "../db/connection";
import { getSetting, setSetting } from "./registry";

/** Variant of the logo asset that is served (SPEC §25.1). */
export const LOGO_VARIANT = "webp_logo";

/** Hash of the branding logo in use, or null (none, or not processed yet). */
export function instanceLogoHash(db: Db): string | null {
  const assetId = getSetting(db, "branding.logoAssetId");
  if (!assetId) return null;
  return getVariant(db, assetId, LOGO_VARIANT)?.blobHash ?? null;
}

/** Error code of a rejected logo, from the job's failure message. */
function logoErrorCode(message: string | null): string {
  return message?.includes("LOGO_TOO_WIDE") ? "LOGO_TOO_WIDE" : "UNSUPPORTED_FILE";
}

/** The logo in use and a pending upload, for the admin settings (SPEC §25.1). */
export function instanceLogo(db: Db): InstanceLogo {
  const pendingId = getSetting(db, "branding.logoPendingAssetId");
  const pendingAsset = pendingId ? getAsset(db, pendingId) : undefined;
  let pending: InstanceLogo["pending"] = null;
  if (pendingAsset && pendingAsset.status !== "ready") {
    pending =
      pendingAsset.status === "failed"
        ? { status: "failed", error: logoErrorCode(pendingAsset.error) }
        : { status: pendingAsset.status === "processing" ? "processing" : "queued", error: null };
  }
  return { hash: instanceLogoHash(db), pending };
}

/** Called by the ingest job: a processed pending logo becomes the logo in use. */
export function promotePendingLogo(db: Db, assetId: string, now: number = Date.now()): boolean {
  if (getSetting(db, "branding.logoPendingAssetId") !== assetId) return false;
  db.transaction(() => {
    setSetting(db, "branding.logoAssetId", assetId, now);
    setSetting(db, "branding.logoPendingAssetId", null, now);
  });
  return true;
}
