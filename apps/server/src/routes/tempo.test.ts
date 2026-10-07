import { logicFixture, reaperFixture, smpteFixtureBytes } from "@bandroom/fixtures";
import {
  createSongRow,
  findUserByLogin,
  listEvents,
  setProjectGrantRow,
  updateUser,
} from "@bandroom/server-core";
import {
  createMarker,
  createProject,
  deleteSongTempo,
  getSongTempo,
  importSongTempoMidi,
  listSongMarkers,
  listTempoRevisions,
  putSongTempo,
  restoreTempoRevision,
  updateMarker,
  type Marker,
  type SongTempo,
  type TempoRevision,
} from "@bandroom/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, loginAs, seedUser, type TestApp } from "../testing/testApp";

let t: TestApp;
let editor: string;
let member: string; // contributor: may not edit tempo
let songId: string;
let projectId: string;

beforeAll(async () => {
  t = await createTestApp();
  const boss = await seedUser(t, "boss", "admin");
  const ed = await seedUser(t, "eda", "member");
  await seedUser(t, "petr", "member");
  const admin = await loginAs(t, "boss");
  editor = await loginAs(t, "eda");
  member = await loginAs(t, "petr");
  projectId = (await call(t, createProject, { body: { name: "Album" } }, admin)).json<{
    project: { id: string };
  }>().project.id;
  setProjectGrantRow(t.db, projectId, ed.id, "editor", boss.id);
  songId = createSongRow(t.db, { projectId, title: "Song", createdBy: boss.id }).id;
});
afterAll(async () => {
  await t.close();
});

const four = { num: 4, den: 4 };
const tempo = async (cookie = member) =>
  (await call(t, getSongTempo, { params: { id: songId } }, cookie)).json<{
    tempo: SongTempo | null;
    timelineRev: number;
  }>();
const markers = async () =>
  (await call(t, listSongMarkers, { params: { id: songId } }, member)).json<{
    markers: Marker[];
  }>().markers;
const put = (bpm: number, bar1OffsetSec = 0, cookie = editor) =>
  call(
    t,
    putSongTempo,
    {
      params: { id: songId },
      body: { map: { segments: [{ startBeat: 0, bpm, meter: four }] }, bar1OffsetSec },
    },
    cookie,
  );
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

describe("tempo maps (SPEC §7.1–§7.3)", () => {
  it("starts without a tempo map; musical anchors fall back to time", async () => {
    expect((await tempo()).tempo).toBeNull();
    const m = await call(
      t,
      createMarker,
      {
        params: { id: songId },
        body: { type: "marker", name: "Early", color: "red", startSec: 3, anchor: "musical" },
      },
      member,
    );
    expect(m.json<{ marker: Marker }>().marker).toMatchObject({ anchor: "time", startBeat: null });
  });

  it("sets a manual tempo (editors only), moves musical items and keeps time items", async () => {
    expect((await put(120, 0, member)).statusCode).toBe(403);
    const rev0 = (await tempo()).timelineRev;
    const res = await put(120, 0.5);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ tempo: SongTempo }>().tempo).toMatchObject({
      source: "manual",
      bar1OffsetSec: 0.5,
      midiFileName: null,
      updatedByName: "Eda",
    });
    expect((await tempo()).timelineRev).toBeGreaterThan(rev0);

    // A section snapped to bars 2–3 (musical), then the tempo doubles: it moves with the music.
    const s = await call(
      t,
      createMarker,
      {
        params: { id: songId },
        body: {
          type: "section",
          name: "Verse",
          color: "blue",
          startSec: 2.5,
          endSec: 4.5,
          anchor: "musical",
        },
      },
      member,
    );
    const section = s.json<{ marker: Marker }>().marker;
    expect(section).toMatchObject({ anchor: "musical", startBeat: 4, endBeat: 8 });
    await put(240, 0.5);
    const after = await markers();
    expect(after.find((x) => x.id === section.id)).toMatchObject({ startSec: 1.5, endSec: 2.5 });
    expect(after.find((x) => x.name === "Early")?.startSec).toBe(3);

    // Converting to time keeps the position; back to musical derives the beats again.
    const toTime = await call(
      t,
      updateMarker,
      { params: { id: section.id }, body: { anchor: "time" } },
      member,
    );
    expect(toTime.json<{ marker: Marker }>().marker).toMatchObject({
      anchor: "time",
      startBeat: null,
      startSec: 1.5,
    });
    const back = await call(
      t,
      updateMarker,
      { params: { id: section.id }, body: { anchor: "musical" } },
      member,
    );
    expect(back.json<{ marker: Marker }>().marker).toMatchObject({ startBeat: 4, endBeat: 8 });
  });

  it("rejects invalid maps", async () => {
    const bad = await call(
      t,
      putSongTempo,
      {
        params: { id: songId },
        body: {
          map: {
            segments: [
              { startBeat: 0, bpm: 120, meter: four },
              { startBeat: 2, bpm: 120, meter: { num: 3, den: 4 } },
            ],
          },
          bar1OffsetSec: 0,
        },
      },
      editor,
    );
    expect(bad.statusCode).toBe(400);
  });

  it("imports a Reaper export with markers as musical items", async () => {
    const f = reaperFixture();
    const res = await call(
      t,
      importSongTempoMidi,
      {
        params: { id: songId },
        body: { fileName: f.name, data: b64(f.bytes), markers: [0, 2, 4, 99] },
      },
      editor,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json<{ tempo: SongTempo; markersCreated: number }>();
    expect(body.markersCreated).toBe(3);
    expect(body.tempo).toMatchObject({ source: "midi", midiFileName: f.name, bar1OffsetSec: 0 });
    expect(
      body.tempo.map.segments.map((s) => ({
        startBeat: s.startBeat,
        bpm: s.bpm,
        num: s.meter.num,
        den: s.meter.den,
      })),
    ).toEqual(f.segments);
    const imported = (await markers()).filter((m) => ["Intro", "Chorus", "Outro"].includes(m.name));
    expect(imported.map((m) => [m.name, m.anchor, m.startBeat])).toEqual([
      ["Intro", "musical", 0],
      ["Chorus", "musical", 32],
      ["Outro", "musical", 60],
    ]);
    // Chorus: 32 beats at 120 = 16 s; Outro: + 16 beats at 140 + 12 beats at 140.
    expect(imported[1]?.startSec).toBeCloseTo(16, 9);
    expect(imported[2]?.startSec).toBeCloseTo(16 + (28 * 60) / 140, 9);
    const ev = listEvents(t.db, { action: "markers.imported" });
    expect(ev.at(-1)?.details).toContain('"count":3');
  });

  it("imports a Logic export (duplicates at tick 0, UTF-8 names, mid-bar tempo)", async () => {
    const f = logicFixture();
    const res = await call(
      t,
      importSongTempoMidi,
      { params: { id: songId }, body: { fileName: f.name, data: b64(f.bytes), markers: [1] } },
      editor,
    );
    expect(res.statusCode).toBe(200);
    const segs = res.json<{ tempo: SongTempo }>().tempo.map.segments;
    expect(
      segs.map((s) => [s.startBeat, s.bpm, `${s.meter.num}/${s.meter.den}`, s.barIndex]),
    ).toEqual([
      [0, 100, "4/4", 0],
      [32, 100, "7/8", 8],
      [36.5, 128, "7/8", 9],
      [42.5, 128, "4/4", 11],
    ]);
    expect((await markers()).some((m) => m.name === "Refrén" && m.anchor === "musical")).toBe(true);
  });

  it("rejects SMPTE, garbage and oversize files with stable codes", async () => {
    const imp = (data: string) =>
      call(
        t,
        importSongTempoMidi,
        { params: { id: songId }, body: { fileName: "x.mid", data, markers: [] } },
        editor,
      );
    expect((await imp(b64(smpteFixtureBytes()))).json<{ code: string }>().code).toBe("MIDI_SMPTE");
    expect((await imp(b64(new Uint8Array([1, 2, 3, 4])))).json<{ code: string }>().code).toBe(
      "MIDI_INVALID",
    );
    const tooBig = await imp("A".repeat(1_398_104));
    expect(tooBig.json<{ code: string }>().code).toBe("FILE_TOO_LARGE");
    expect(
      (
        await call(
          t,
          importSongTempoMidi,
          { params: { id: songId }, body: { fileName: "x.mid", data: "", markers: [] } },
          member,
        )
      ).statusCode,
    ).toBe(403);
  });

  it("checks the quota before storing a MIDI file", async () => {
    const eda = findUserByLogin(t.db, "eda");
    if (!eda) throw new Error("eda missing");
    const before = (await tempo()).tempo;
    updateUser(t.db, eda.id, { quotaBytes: 10 });
    try {
      const f = reaperFixture();
      const res = await call(
        t,
        importSongTempoMidi,
        { params: { id: songId }, body: { fileName: f.name, data: b64(f.bytes), markers: [] } },
        editor,
      );
      expect(res.json<{ code: string }>().code).toBe("QUOTA_EXCEEDED");
      expect((await tempo()).tempo).toEqual(before);
    } finally {
      updateUser(t.db, eda.id, { quotaBytes: null });
    }
  });

  it("rolls back the asset, revision and events when a marker cannot be stored", async () => {
    const count = (table: string, where = "1") =>
      (
        t.db.$client.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as {
          n: number;
        }
      ).n;
    const snapshot = () => ({
      assets: count("assets", "kind = 'midi'"),
      revisions: count("tempo_map_revisions"),
      markers: count("markers"),
      events: count("events"),
    });
    const before = snapshot();
    const tempoBefore = (await tempo()).tempo;
    t.db.$client.exec(
      "CREATE TRIGGER fail_marker BEFORE INSERT ON markers BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    try {
      const f = reaperFixture();
      const res = await call(
        t,
        importSongTempoMidi,
        { params: { id: songId }, body: { fileName: f.name, data: b64(f.bytes), markers: [0] } },
        editor,
      );
      expect(res.statusCode).toBe(500);
    } finally {
      t.db.$client.exec("DROP TRIGGER fail_marker");
    }
    expect(snapshot()).toEqual(before);
    expect((await tempo()).tempo).toEqual(tempoBefore);
  });

  it("keeps revisions, restores one and logs every change", async () => {
    const list = (await call(t, listTempoRevisions, { params: { id: songId } }, member)).json<{
      revisions: TempoRevision[];
    }>().revisions;
    expect(list.map((r) => r.source)).toEqual(["midi", "midi", "manual", "manual"]);
    const first = list.at(-1);
    if (!first) throw new Error("no revision");
    expect(first.map.segments[0]?.bpm).toBe(120);
    expect(
      (
        await call(
          t,
          restoreTempoRevision,
          { params: { id: songId, revisionId: first.id } },
          member,
        )
      ).statusCode,
    ).toBe(403);
    const restored = await call(
      t,
      restoreTempoRevision,
      { params: { id: songId, revisionId: first.id } },
      editor,
    );
    expect(restored.json<{ tempo: SongTempo }>().tempo).toMatchObject({
      source: "manual",
      bar1OffsetSec: 0.5,
    });
    const missing = await call(
      t,
      restoreTempoRevision,
      { params: { id: songId, revisionId: "nope" } },
      editor,
    );
    expect(missing.statusCode).toBe(404);
    const details = listEvents(t.db, { action: "tempo.changed" }).map(
      (e) => (JSON.parse(e.details ?? "{}") as { action: string }).action,
    );
    expect(details).toEqual(["set", "set", "import", "import", "restore"]);
  });

  it("deletes the tempo map: musical items keep their times and become time-anchored", async () => {
    const before = (await markers()).find((m) => m.name === "Chorus");
    expect(before?.anchor).toBe("musical");
    expect((await call(t, deleteSongTempo, { params: { id: songId } }, editor)).statusCode).toBe(
      200,
    );
    expect((await tempo()).tempo).toBeNull();
    const after = (await markers()).find((m) => m.name === "Chorus");
    expect(after).toMatchObject({ anchor: "time", startBeat: null, startSec: before?.startSec });
    // A second delete is a no-op without another event.
    await call(t, deleteSongTempo, { params: { id: songId } }, editor);
    expect(listEvents(t.db, { action: "tempo.changed" })).toHaveLength(6);
    // History survives the delete.
    const revs = (await call(t, listTempoRevisions, { params: { id: songId } }, member)).json<{
      revisions: TempoRevision[];
    }>().revisions;
    expect(revs).toHaveLength(5);
  });
});
