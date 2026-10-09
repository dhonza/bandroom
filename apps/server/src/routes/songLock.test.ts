import {
  createAsset,
  createSongRow,
  createTrackWithVersion,
  listEvents,
  setProjectGrantRow,
} from "@bandroom/server-core";
import {
  ApiErrorSchema,
  createComment,
  convertMarkers,
  createMarker,
  createMixerSnapshot,
  createProject,
  deleteComment,
  deleteMarker,
  deleteSongTempo,
  getSong,
  lockSong,
  putSongMixer,
  putSongTempo,
  resolveComment,
  restoreMarker,
  setCommentReaction,
  unlockSong,
  updateComment,
  updateMarker,
  updateSong,
  updateTrack,
  updateTrackVersion,
  type ContractDef,
  type Song,
  type StreamEvent,
} from "@bandroom/shared";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, loginAs, seedUser, type TestApp } from "../testing/testApp";

let t: TestApp;
let admin: string;
let editor: string;
let editorId: string;
let member: string; // contributor
let projectId: string;
let songId: string;
let trackId: string;
let versionId: string;
let markerId: string;
let commentId: string;
const published: StreamEvent[] = [];

const codeOf = (res: LightMyRequestResponse) =>
  res.statusCode >= 400 ? ApiErrorSchema.parse(res.json()).code : "ok";
const songOf = async (cookie = member) =>
  (await call(t, getSong, { params: { id: songId } }, cookie)).json<{ song: Song }>().song;
const lock = (cookie = editor) => call(t, lockSong, { params: { id: songId } }, cookie);
const unlock = (cookie = editor) => call(t, unlockSong, { params: { id: songId } }, cookie);

beforeAll(async () => {
  t = await createTestApp();
  const boss = await seedUser(t, "boss", "admin");
  const eda = await seedUser(t, "eda", "member");
  editorId = eda.id;
  await seedUser(t, "petr", "member");
  admin = await loginAs(t, "boss");
  editor = await loginAs(t, "eda");
  member = await loginAs(t, "petr");
  projectId = (await call(t, createProject, { body: { name: "Album" } }, admin)).json<{
    project: { id: string };
  }>().project.id;
  setProjectGrantRow(t.db, projectId, eda.id, "editor", boss.id);
  songId = createSongRow(t.db, { projectId, title: "Song", createdBy: boss.id }).id;
  const asset = createAsset(t.db, {
    kind: "audio",
    originalFilename: "bass.wav",
    sizeBytes: 1,
    originalHash: "0".repeat(64),
    uploadedBy: eda.id,
  });
  const created = createTrackWithVersion(t.db, {
    songId,
    name: "Bass",
    assetId: asset.id,
    uploadedBy: eda.id,
  });
  trackId = created.track.id;
  versionId = created.version.id;
  markerId = (
    await call(
      t,
      createMarker,
      { params: { id: songId }, body: { type: "marker", name: "A", color: "red", startSec: 1 } },
      member,
    )
  ).json<{ marker: { id: string } }>().marker.id;
  commentId = (
    await call(t, createComment, { params: { id: songId }, body: { body: "Hi" } }, member)
  ).json<{ comment: { id: string } }>().comment.id;
  t.hub.subscribe({ canSee: () => true, send: () => undefined }, null);
  const publish = t.hub.publish.bind(t.hub);
  t.hub.publish = (e, now) => {
    published.push(e);
    return publish(e, now);
  };
});
afterAll(async () => {
  await t.close();
});

/** Every request a lock freezes, with a body that is valid for it. */
const FROZEN: [string, ContractDef, () => Record<string, unknown>][] = [
  [
    "create marker",
    createMarker,
    () => ({
      params: { id: songId },
      body: { type: "marker", name: "B", color: "red", startSec: 2 },
    }),
  ],
  ["update marker", updateMarker, () => ({ params: { id: markerId }, body: { name: "A2" } })],
  ["delete marker", deleteMarker, () => ({ params: { id: markerId } })],
  ["restore marker", restoreMarker, () => ({ params: { id: markerId } })],
  [
    "convert markers",
    convertMarkers,
    () => ({ params: { id: songId }, body: { ids: [markerId], to: "section" } }),
  ],
  ["create comment", createComment, () => ({ params: { id: songId }, body: { body: "Yo" } })],
  ["edit comment", updateComment, () => ({ params: { id: commentId }, body: { body: "Hey" } })],
  ["delete comment", deleteComment, () => ({ params: { id: commentId } })],
  [
    "resolve comment",
    resolveComment,
    () => ({ params: { id: commentId }, body: { resolved: true } }),
  ],
  [
    "react",
    setCommentReaction,
    () => ({ params: { id: commentId }, body: { emoji: "👍", active: true } }),
  ],
  [
    "put tempo",
    putSongTempo,
    () => ({
      params: { id: songId },
      body: {
        map: { segments: [{ startBeat: 0, bpm: 120, meter: { num: 4, den: 4 } }] },
        bar1OffsetSec: 0,
      },
    }),
  ],
  ["delete tempo", deleteSongTempo, () => ({ params: { id: songId } })],
  ["default gain", updateTrack, () => ({ params: { id: trackId }, body: { defaultGainDb: -3 } })],
  ["default pan", updateTrack, () => ({ params: { id: trackId }, body: { defaultPan: 0.5 } })],
  [
    "default mute with a name",
    updateTrack,
    () => ({ params: { id: trackId }, body: { name: "Bass 2", defaultMuted: true } }),
  ],
  ["instrument", updateTrack, () => ({ params: { id: trackId }, body: { instrument: "bass" } })],
  ["transpose", updateTrack, () => ({ params: { id: trackId }, body: { transpose: null } })],
  ["voice range", updateTrack, () => ({ params: { id: trackId }, body: { voiceRange: "low" } })],
  ["version gain", updateTrackVersion, () => ({ params: { id: versionId }, body: { gainDb: 2 } })],
];

/** Changes that stay allowed while locked. */
const ALLOWED: [string, ContractDef, () => Record<string, unknown>][] = [
  [
    "track name and colour",
    updateTrack,
    () => ({ params: { id: trackId }, body: { name: "Bas", color: "blue" } }),
  ],
  [
    "version label",
    updateTrackVersion,
    () => ({ params: { id: versionId }, body: { label: "take 2" } }),
  ],
  [
    "personal mixer",
    putSongMixer,
    () => ({ params: { id: songId }, body: { state: { tracks: {} } } }),
  ],
  [
    "snapshot",
    createMixerSnapshot,
    () => ({ params: { id: songId }, body: { name: "Mine", state: { tracks: {} } } }),
  ],
  ["song details", updateSong, () => ({ params: { id: songId }, body: { key: "A minor" } })],
];

describe("song lock (SPEC §25.12)", () => {
  it("is set by editors, shown to everyone, logged and published", async () => {
    expect((await songOf()).locked).toBeNull();
    expect(codeOf(await lock(member))).toBe("FORBIDDEN");
    const res = await lock();
    expect(res.statusCode).toBe(200);
    const locked = res.json<{ song: Song }>().song.locked;
    expect(locked).toMatchObject({ by: { id: editorId, displayName: "Eda" } });
    expect((await songOf()).locked).toEqual(locked);
    // Idempotent: a second lock keeps the first one's time and logs nothing.
    expect((await lock(admin)).json<{ song: Song }>().song.locked).toEqual(locked);
    const events = listEvents(t.db, { action: "song.locked" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ songId, targetType: "song", targetId: songId });
    expect(published.filter((e) => e.type === "song.updated" && e.songId === songId)).toEqual([
      expect.objectContaining({ projectId, data: { locked: true } }),
    ]);
  });

  it.each(FROZEN)("refuses: %s", async (_name, contract, input) => {
    // Admins have no bypass: an editor (or admin) unlocks explicitly.
    for (const cookie of [editor, admin]) {
      const res = await call(t, contract, input(), cookie);
      expect(codeOf(res)).toBe("SONG_LOCKED");
      expect(res.statusCode).toBe(409);
    }
  });

  it.each(ALLOWED)("still allows: %s", async (_name, contract, input) => {
    expect(codeOf(await call(t, contract, input(), editor))).toBe("ok");
  });

  it("checks capabilities before the lock", async () => {
    // A contributor may not edit the tempo anyway: FORBIDDEN, not SONG_LOCKED.
    const [, contract, input] = FROZEN.find(([n]) => n === "put tempo") ?? [];
    if (!contract || !input) throw new Error("missing case");
    expect(codeOf(await call(t, contract, input(), member))).toBe("FORBIDDEN");
  });

  it("unlocks idempotently and the frozen changes work again", async () => {
    const before = listEvents(t.db, { action: "song.unlocked" }).length;
    expect(codeOf(await unlock(member))).toBe("FORBIDDEN");
    expect((await unlock()).json<{ song: Song }>().song.locked).toBeNull();
    expect(codeOf(await unlock())).toBe("ok");
    expect(listEvents(t.db, { action: "song.unlocked" })).toHaveLength(before + 1);
    expect(published.at(-1)).toMatchObject({ type: "song.updated", data: { locked: false } });
    // Deletes last, so the other changes still find their targets; a restore follows the delete.
    const isDelete = (c: ContractDef) => c.method === "DELETE";
    const ordered = [
      ...FROZEN.filter(([, c]) => !isDelete(c) && c !== restoreMarker),
      ...FROZEN.filter(([, c]) => isDelete(c)),
      ...FROZEN.filter(([, c]) => c === restoreMarker),
    ];
    for (const [name, contract, input] of ordered) {
      const res = await call(t, contract, input(), editor);
      expect([name, codeOf(res)]).toEqual([name, "ok"]);
    }
  });
});
