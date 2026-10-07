import { listEvents } from "@bandroom/server-core";
import { adminGetSettings, adminRemoveLogo, getMeta } from "@bandroom/shared";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { call, runQueuedJobs, tusUpload } from "../testing/testApp";
import { admin, member, setupUploadFixtures, t } from "../testing/uploadFixtures";

setupUploadFixtures();

const png = (width: number, height: number) =>
  sharp({
    create: { width, height, channels: 4, background: { r: 200, g: 120, b: 40, alpha: 0.5 } },
  })
    .png()
    .toBuffer();

const settings = async () =>
  (await call(t, adminGetSettings, undefined, admin)).json<{
    logo: { hash: string | null; pending: { status: string; error: string | null } | null };
  }>().logo;

describe("branding logo (SPEC §25.1)", () => {
  it("only admins may upload a logo", async () => {
    const res = await tusUpload(t, member, await png(200, 100), "logo.png", {
      type: "instanceLogo",
    });
    expect(res.createStatus).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ code: "FORBIDDEN" });
  });

  it("uploads, processes and serves the logo publicly", async () => {
    const res = await tusUpload(t, admin, await png(400, 200), "logo.png", {
      type: "instanceLogo",
    });
    expect(res.status).toBe(200);
    expect(await settings()).toEqual({ hash: null, pending: { status: "queued", error: null } });
    expect(
      listEvents(t.db, { action: "settings.changed" }).some((e) =>
        JSON.stringify(e.details).includes("logo"),
      ),
    ).toBe(true);

    expect(await runQueuedJobs(t)).toEqual(["done"]);
    const logo = await settings();
    expect(logo.pending).toBeNull();
    expect(logo.hash).toMatch(/^[0-9a-f]{64}$/);
    const meta = (await call(t, getMeta, undefined)).json<{ logoHash: string | null }>();
    expect(meta.logoHash).toBe(logo.hash);

    // Anonymous visitors (login page, public links) load it.
    const img = await t.app.inject({ url: `/api/v1/branding/logo/${logo.hash ?? ""}` });
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/webp");
    expect(img.headers["cache-control"]).toContain("public");
    expect(await sharp(img.rawPayload).metadata()).toMatchObject({ width: 128, height: 64 });
    // The injected client config carries it too.
    const html = await t.app.inject({ url: "/", headers: { accept: "text/html" } });
    expect(html.body).toContain(logo.hash);
  }, 60_000);

  it("never serves other blobs through the logo route", async () => {
    const res = await t.app.inject({ url: `/api/v1/branding/logo/${"0".repeat(64)}` });
    expect(res.statusCode).toBe(404);
  });

  it("rejects a logo wider than 4:1 and keeps the current one", async () => {
    const before = (await settings()).hash;
    await tusUpload(t, admin, await png(1000, 200), "wide.png", { type: "instanceLogo" });
    expect(await runQueuedJobs(t)).toEqual(["failed"]);
    expect(await settings()).toEqual({
      hash: before,
      pending: { status: "failed", error: "LOGO_TOO_WIDE" },
    });
  }, 60_000);

  it("removes the logo", async () => {
    const res = await call(t, adminRemoveLogo, undefined, admin);
    expect(res.json()).toEqual({ logo: { hash: null, pending: null } });
    expect((await call(t, getMeta, undefined)).json<{ logoHash: unknown }>().logoHash).toBeNull();
    expect((await call(t, adminRemoveLogo, undefined, member)).statusCode).toBe(403);
  });
});
