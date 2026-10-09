import { getSongRow, getTrackVersionRow, listEvents } from "@bandroom/server-core";
import {
  ApiErrorSchema,
  MAX_OFFSET_SAMPLES,
  setProjectGrant,
  updateTrackVersion,
  UploadResultSchema,
} from "@bandroom/shared";
import { describe, expect, it } from "vitest";
import { call, loginAs, seedUser, tusUpload } from "../testing/testApp";
import {
  admin,
  member,
  memberId,
  projectId,
  setupUploadFixtures,
  songId,
  t,
} from "../testing/uploadFixtures";

setupUploadFixtures();

// Ingest is not run: these tests only check where the upload lands and who may make it.
const take = Buffer.from("fLaC fake take bytes");

async function withRole(username: string, role: "viewer" | "commenter" | "contributor") {
  const user = await seedUser(t, username, "member");
  await call(
    t,
    setProjectGrant,
    { params: { id: projectId, userId: user.id }, body: { role } },
    admin,
  );
  return { id: user.id, cookie: await loginAs(t, username) };
}

function details(e: { details: string | null }): unknown {
  return JSON.parse(e.details ?? "null") as unknown;
}

describe("recorded takes (SPEC §9)", () => {
  let trackId = "";
  let versionId = "";

  it("uploads a take as a new track with its source and position", async () => {
    const res = await tusUpload(t, member, take, "take.flac", {
      type: "newTrack",
      songId,
      name: "Recording 1",
      source: "recording",
      offsetSamples: 12_345,
    });
    expect(res.status).toBe(200);
    const result = UploadResultSchema.parse(JSON.parse(res.body));
    trackId = result.trackId ?? "";
    versionId = result.trackVersionId ?? "";
    expect(getTrackVersionRow(t.db, versionId)).toMatchObject({
      source: "recording",
      offsetSamples: 12_345,
      uploadedBy: memberId,
    });
    const recorded = listEvents(t.db, { action: "version.recorded", targetId: versionId });
    expect(recorded.map(details)).toEqual([
      { trackId, assetId: result.assetId, offsetSamples: 12_345 },
    ]);
    expect(listEvents(t.db, { action: "version.uploaded", targetId: versionId })).toEqual([]);
  });

  it("keeps plain uploads at source upload and position 0", async () => {
    const res = await tusUpload(t, member, Buffer.from("plain"), "plain.wav", {
      type: "newVersion",
      trackId,
    });
    const id = UploadResultSchema.parse(JSON.parse(res.body)).trackVersionId ?? "";
    expect(getTrackVersionRow(t.db, id)).toMatchObject({ source: "upload", offsetSamples: 0 });
    expect(listEvents(t.db, { action: "version.uploaded", targetId: id })).toHaveLength(1);
  });

  it("adds a take as a new version", async () => {
    const res = await tusUpload(t, member, Buffer.from("take two"), "take2.flac", {
      type: "newVersion",
      trackId,
      source: "recording",
      offsetSamples: 0,
    });
    const id = UploadResultSchema.parse(JSON.parse(res.body)).trackVersionId ?? "";
    expect(getTrackVersionRow(t.db, id)).toMatchObject({ source: "recording", number: 3 });
    expect(listEvents(t.db, { action: "version.recorded", targetId: id })).toHaveLength(1);
  });

  it("refuses invalid positions", async () => {
    for (const offsetSamples of [-1, 1.5, MAX_OFFSET_SAMPLES + 1]) {
      const res = await tusUpload(t, member, take, "x.flac", {
        type: "newTrack",
        songId,
        name: "X",
        source: "recording",
        offsetSamples,
      });
      expect(ApiErrorSchema.parse(JSON.parse(res.body)).code).toBe("VALIDATION_FAILED");
    }
    const other = await tusUpload(t, member, take, "x.flac", {
      type: "newTrack",
      songId,
      name: "X",
      source: "import",
    });
    expect(ApiErrorSchema.parse(JSON.parse(other.body)).code).toBe("VALIDATION_FAILED");
  });

  it("needs record: viewers and commenters may not upload takes", async () => {
    for (const role of ["viewer", "commenter"] as const) {
      const { cookie } = await withRole(`rec-${role}`, role);
      for (const target of [
        { type: "newTrack", songId, name: "X", source: "recording" },
        { type: "newVersion", trackId, source: "recording" },
        { type: "newSong", projectId, title: "S", trackName: "X", source: "recording" },
      ]) {
        const res = await tusUpload(t, cookie, take, "x.flac", target);
        expect(res.createStatus, `${role} ${target.type}`).toBe(403);
        expect(ApiErrorSchema.parse(JSON.parse(res.body)).code).toBe("FORBIDDEN");
      }
    }
  });

  it("creates a song from a project-page take (song.create)", async () => {
    // Contributors may record into songs but not add songs.
    const denied = await tusUpload(t, member, take, "take.flac", {
      type: "newSong",
      projectId,
      title: "Recording 2026-10-09 19:30",
      trackName: "Recording",
      source: "recording",
    });
    expect(denied.createStatus).toBe(403);

    const res = await tusUpload(t, admin, take, "take.flac", {
      type: "newSong",
      projectId,
      title: "Recording 2026-10-09 19:30",
      trackName: "Recording",
      source: "recording",
      offsetSamples: 480,
    });
    expect(res.status).toBe(200);
    const result = UploadResultSchema.parse(JSON.parse(res.body));
    const version = getTrackVersionRow(t.db, result.trackVersionId ?? "");
    expect(version).toMatchObject({ source: "recording", offsetSamples: 480 });
    const created = listEvents(t.db, { action: "song.created" }).at(-1);
    const song = getSongRow(t.db, created?.targetId ?? "");
    expect(song).toMatchObject({ projectId, title: "Recording 2026-10-09 19:30" });
    expect(created?.songId).toBe(song?.id);
    const recorded = listEvents(t.db, { action: "version.recorded", targetId: version?.id });
    expect(recorded[0]?.songId).toBe(song?.id);
  });

  it("adjusts a version's position (uploader, track creator or editor)", async () => {
    const patch = (cookie: string, body: Record<string, unknown>) =>
      call(t, updateTrackVersion, { params: { id: versionId }, body }, cookie);
    expect((await patch(member, { offsetSamples: 12_000 })).statusCode).toBe(200);
    expect(getTrackVersionRow(t.db, versionId)?.offsetSamples).toBe(12_000);
    // Unchanged: nothing logged.
    expect((await patch(member, { offsetSamples: 12_000 })).statusCode).toBe(200);
    expect((await patch(admin, { offsetSamples: 0 })).statusCode).toBe(200);

    const other = await withRole("rec-other", "contributor");
    const denied = await patch(other.cookie, { offsetSamples: 5 });
    expect(ApiErrorSchema.parse(denied.json()).code).toBe("FORBIDDEN");
    for (const bad of [-1, 0.5, "5", MAX_OFFSET_SAMPLES + 1])
      expect((await patch(admin, { offsetSamples: bad })).statusCode).toBe(400);

    const events = listEvents(t.db, { action: "version.updated", targetId: versionId });
    expect(events.map(details)).toEqual([
      { changes: ["offsetSamples"], trackId, before: 12_345, after: 12_000 },
      { changes: ["offsetSamples"], trackId, before: 12_000, after: 0 },
    ]);
  });
});
