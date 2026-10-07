import { outputSide, type Square } from "./crop";

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, type, quality);
  });
}

/**
 * Crops `image` to the square, scaled down to at most 1024 px (SPEC §25.4). WebP where the
 * browser can encode it, else PNG (Safari has no WebP encoder; it returns PNG for WebP). A GIF
 * gives its current (first) frame.
 */
export async function cropToFile(image: HTMLImageElement, s: Square, name: string): Promise<File> {
  const side = outputSide(s);
  const canvas = document.createElement("canvas");
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is not available");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, s.x, s.y, s.size, s.size, 0, 0, side, side);
  let blob = await toBlob(canvas, "image/webp", 0.92);
  if (blob?.type !== "image/webp") blob = await toBlob(canvas, "image/png");
  if (!blob) throw new Error("The cropped image could not be encoded");
  const ext = blob.type === "image/webp" ? "webp" : "png";
  const base = name.replace(/\.[^./]*$/, "").slice(0, 100) || "project-image";
  return new File([blob], `${base}.${ext}`, { type: blob.type });
}

/** Decodes an image blob for cropping; rejects when the browser cannot read it. */
export async function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  await img.decode();
  if (img.naturalWidth === 0 || img.naturalHeight === 0) throw new Error("Empty image");
  return img;
}
