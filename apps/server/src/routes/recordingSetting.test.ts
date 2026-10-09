import { listEvents } from "@bandroom/server-core";
import { adminGetSettings, adminUpdateSettings, getMeta } from "@bandroom/shared";
import { describe, expect, it } from "vitest";
import { call } from "../testing/testApp";
import { admin, member, setupUploadFixtures, t } from "../testing/uploadFixtures";

setupUploadFixtures();

function details(e: { details: string | null }): unknown {
  return JSON.parse(e.details ?? "null") as unknown;
}

describe("recording.maxTakeMinutes (SPEC §9)", () => {
  it("defaults to 180, is exposed to clients and editable by admins in 1–600", async () => {
    const meta = async () =>
      (await call(t, getMeta, undefined)).json<{ recordingMaxTakeMinutes: number }>()
        .recordingMaxTakeMinutes;
    expect(await meta()).toBe(180);
    expect((await call(t, adminGetSettings, {}, admin)).json()).toMatchObject({
      settings: { recordingMaxTakeMinutes: 180 },
    });
    const update = (value: unknown, cookie = admin) =>
      call(t, adminUpdateSettings, { body: { recordingMaxTakeMinutes: value } }, cookie);
    for (const bad of [0, 601, 90.5, "60"]) expect((await update(bad)).statusCode).toBe(400);
    expect((await update(60, member)).statusCode).toBe(403);
    const before = listEvents(t.db, { action: "settings.changed" }).length;
    expect((await update(60)).statusCode).toBe(200);
    expect(await meta()).toBe(60);
    const changed = listEvents(t.db, { action: "settings.changed" });
    expect(changed).toHaveLength(before + 1);
    expect(details(changed.at(-1) ?? { details: null })).toMatchObject({
      before: { recordingMaxTakeMinutes: 180 },
      after: { recordingMaxTakeMinutes: 60 },
    });
  });
});
