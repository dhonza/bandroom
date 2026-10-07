import path from "node:path";
import { LOGO_HEIGHT, LOGO_MAX_ASPECT, logoAspectAllowed } from "@bandroom/shared";
import sharp, { type Metadata } from "sharp";
import { z } from "zod";
import { PermanentJobError, type JobContext, type JobHandler } from "../jobs/types";
import { LOGO_VARIANT, promotePendingLogo } from "../settings/branding";
import { getAsset, setAssetStatus } from "./assets";

// libvips: one thread, no operation cache (SPEC §19.6, 1 GB RAM target).
sharp.concurrency(1);
sharp.cache(false);

export const IMAGE_SIZES = [256, 512, 1024] as const;

export const ImageIngestPayloadSchema = z.object({
  assetId: z.string(),
  /** Project images are cover-cropped to squares; document images keep their aspect ratio. */
  crop: z.boolean().default(true),
  projectId: z.string().nullable().default(null),
  /** Branding logo (SPEC §25.1): one transparent-capable WebP, 64 px high, at most 4:1. */
  logo: z.boolean().default(false),
});
export type ImageIngestPayload = z.infer<typeof ImageIngestPayloadSchema>;

/** `image.ingest` (SPEC §5.7): WebP variants `webp_256/512/1024`, metadata (EXIF) stripped. */
export const imageIngestHandler: JobHandler<ImageIngestPayload, { variants: string[] }> = {
  type: "image.ingest",
  capability: "image.ingest",
  payloadSchema: ImageIngestPayloadSchema,
  async run(ctx, payload) {
    if (!getAsset(ctx.db, payload.assetId)) throw new PermanentJobError("Asset not found");
    setAssetStatus(ctx.db, payload.assetId, "processing");
    const src = await ctx.input({ assetId: payload.assetId, variant: "original" });
    let meta: Metadata;
    try {
      meta = await sharp(src, { limitInputPixels: 64_000_000 }).metadata();
    } catch {
      throw new PermanentJobError("Not a supported image");
    }
    if (!meta.width || !meta.height) throw new PermanentJobError("Image has no dimensions");
    if (payload.logo) {
      const variants = await ingestLogo(ctx, payload.assetId, src, meta);
      setAssetStatus(ctx.db, payload.assetId, "ready");
      promotePendingLogo(ctx.db, payload.assetId);
      return { variants };
    }

    const variants: string[] = [];
    for (const [i, size] of IMAGE_SIZES.entries()) {
      const out = path.join(ctx.tmpDir, `img-${size}.webp`);
      // .rotate() applies EXIF orientation before metadata is dropped (sharp strips it by default).
      const img = sharp(src, { limitInputPixels: 64_000_000 }).rotate();
      const info = await (
        payload.crop
          ? img.resize(size, size, { fit: "cover", position: "attention" })
          : img.resize(size, size, { fit: "inside", withoutEnlargement: true })
      )
        .webp({ quality: 82 })
        .toFile(out);
      const variant = `webp_${size}`;
      await ctx.output({ assetId: payload.assetId, variant }, out, {
        width: info.width,
        height: info.height,
        format: "webp",
      });
      variants.push(variant);
      ctx.progress((i + 1) / IMAGE_SIZES.length);
    }
    setAssetStatus(ctx.db, payload.assetId, "ready");
    return { variants };
  },
};

/** Width and height as shown, after the EXIF orientation (5–8 swap the sides). */
function orientedSize(meta: Metadata): { width: number; height: number } {
  const w = meta.width;
  const h = meta.height;
  return (meta.orientation ?? 1) >= 5 ? { width: h, height: w } : { width: w, height: h };
}

/**
 * The logo variant: fit inside {@link LOGO_HEIGHT} px height (never enlarged), alpha kept,
 * lossless WebP. Wider than 4:1 fails permanently with `LOGO_TOO_WIDE`.
 */
async function ingestLogo(
  ctx: JobContext,
  assetId: string,
  src: string,
  meta: Metadata,
): Promise<string[]> {
  const { width, height } = orientedSize(meta);
  if (!logoAspectAllowed(width, height)) {
    throw new PermanentJobError(`LOGO_TOO_WIDE: ${String(width)}×${String(height)}`);
  }
  const out = path.join(ctx.tmpDir, "logo.webp");
  const info = await sharp(src, { limitInputPixels: 64_000_000 })
    .rotate()
    .resize({
      width: LOGO_HEIGHT * LOGO_MAX_ASPECT,
      height: LOGO_HEIGHT,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ lossless: true })
    .toFile(out);
  await ctx.output({ assetId, variant: LOGO_VARIANT }, out, {
    width: info.width,
    height: info.height,
    format: "webp",
  });
  ctx.progress(1);
  return [LOGO_VARIANT];
}
