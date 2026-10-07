import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../db/connection";
import {
  addOriginal,
  createHarness,
  runOneJob,
  variantPath,
  type Harness,
} from "../testing/ingestHarness";
import { makeTempDir } from "../testing/tempDir";
import { createTestDb } from "../testing/testDb";
import { instanceLogo, instanceLogoHash, LOGO_VARIANT } from "../settings/branding";
import { getSetting, setSetting } from "../settings/registry";
import { getAsset } from "./assets";
import { listVariants } from "./variants";

let t: ReturnType<typeof createTestDb>;
let db: Db;
let tmp: ReturnType<typeof makeTempDir>;
let h: Harness;

beforeAll(() => {
  t = createTestDb();
  db = t.db;
  tmp = makeTempDir();
  h = createHarness(db, tmp.dir);
});
afterAll(() => {
  t.close();
  tmp.cleanup();
});

describe("image.ingest (SPEC §5.7)", () => {
  it("produces square WebP variants without metadata", async () => {
    const src = path.join(tmp.dir, "cover.png");
    await sharp({
      create: { width: 1600, height: 900, channels: 3, background: { r: 200, g: 40, b: 90 } },
    })
      .png()
      .withMetadata({ exif: { IFD0: { Copyright: "secret" } } })
      .toFile(src);
    const asset = await addOriginal(h, src, null, "image");
    const { status } = await runOneJob(h, "image.ingest", { assetId: asset.id, crop: true });
    expect(status).toBe("done");
    expect(getAsset(db, asset.id)?.status).toBe("ready");
    expect(
      listVariants(db, asset.id)
        .map((v) => v.variant)
        .sort(),
    ).toEqual(["original", "webp_1024", "webp_256", "webp_512"]);
    for (const size of [256, 512, 1024]) {
      const meta = await sharp(await variantPath(h, asset.id, `webp_${size}`)).metadata();
      expect(meta).toMatchObject({ format: "webp", width: size, height: size });
      expect(meta.exif).toBeUndefined();
    }
  });

  it("fails permanently for non-images", async () => {
    const bogus = path.join(tmp.dir, "x.png");
    await fs.writeFile(bogus, "not an image");
    const asset = await addOriginal(h, bogus, null, "image");
    expect((await runOneJob(h, "image.ingest", { assetId: asset.id })).status).toBe("failed");
  });

  it("logo mode: 64 px high, alpha kept, promoted when ready (SPEC §25.1)", async () => {
    const src = path.join(tmp.dir, "logo.png");
    await sharp({
      create: { width: 800, height: 256, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 400, height: 128, channels: 4, background: "#c87533" },
          })
            .png()
            .toBuffer(),
          top: 64,
          left: 200,
        },
      ])
      .png()
      .toFile(src);
    const asset = await addOriginal(h, src, null, "image");
    setSetting(db, "branding.logoPendingAssetId", asset.id);
    expect(instanceLogo(db)).toEqual({ hash: null, pending: { status: "queued", error: null } });
    const { status } = await runOneJob(h, "image.ingest", { assetId: asset.id, logo: true });
    expect(status).toBe("done");
    const meta = await sharp(await variantPath(h, asset.id, LOGO_VARIANT)).metadata();
    expect(meta).toMatchObject({ format: "webp", width: 200, height: 64, hasAlpha: true });
    expect(getSetting(db, "branding.logoAssetId")).toBe(asset.id);
    expect(getSetting(db, "branding.logoPendingAssetId")).toBeNull();
    expect(instanceLogoHash(db)).toMatch(/^[0-9a-f]{64}$/);
    expect(instanceLogo(db).pending).toBeNull();
  });

  it("logo mode rejects images wider than 4:1 and keeps the logo in use", async () => {
    const before = getSetting(db, "branding.logoAssetId");
    const src = path.join(tmp.dir, "wide.png");
    await sharp({ create: { width: 900, height: 200, channels: 3, background: "#fff" } })
      .png()
      .toFile(src);
    const asset = await addOriginal(h, src, null, "image");
    setSetting(db, "branding.logoPendingAssetId", asset.id);
    const { status } = await runOneJob(h, "image.ingest", { assetId: asset.id, logo: true });
    expect(status).toBe("failed");
    expect(getAsset(db, asset.id)?.status).toBe("failed");
    expect(getSetting(db, "branding.logoAssetId")).toBe(before);
    expect(instanceLogo(db).pending).toEqual({ status: "failed", error: "LOGO_TOO_WIDE" });
  });

  it("a superseded logo upload does not replace the newer pending one", async () => {
    const src = path.join(tmp.dir, "small.png");
    await sharp({ create: { width: 40, height: 20, channels: 4, background: "#123456" } })
      .png()
      .toFile(src);
    const older = await addOriginal(h, src, null, "image");
    setSetting(db, "branding.logoPendingAssetId", "newer-upload");
    expect((await runOneJob(h, "image.ingest", { assetId: older.id, logo: true })).status).toBe(
      "done",
    );
    expect(getSetting(db, "branding.logoAssetId")).not.toBe(older.id);
    expect(getSetting(db, "branding.logoPendingAssetId")).toBe("newer-upload");
    // never enlarged
    const meta = await sharp(await variantPath(h, older.id, LOGO_VARIANT)).metadata();
    expect(meta).toMatchObject({ width: 40, height: 20 });
  });
});
