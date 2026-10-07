import {
  createMarkerRow,
  createMidiAssetRows,
  deleteSongTempo as deleteTempoRow,
  getTempoRevision,
  listSongTempoRevisions,
  saveSongTempo,
  songTempo,
  songTimelineRev,
  storeMidiBlob,
  type TempoInput,
} from "@bandroom/server-core";
import {
  beatToSec,
  compileTempo,
  deleteSongTempo,
  getSongTempo,
  importSongTempoMidi,
  listTempoRevisions,
  MAX_MIDI_BYTES,
  parseMidiTempo,
  putSongTempo,
  restoreTempoRevision,
  type SongTempo,
} from "@bandroom/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../context";
import { checkQuotaAndDisk } from "../quota";
import { audit } from "../http/audit";
import { registerContract } from "../http/contracts";
import { AppError } from "../http/errors";

type Access = { project: { id: string }; song: { id: string } };

/**
 * Tempo maps (SPEC §7.1–§7.3): manual tempo, MIDI import with markers, history and restore.
 * Editors change tempo (`tempo.edit`); every change is a revision and a `tempo.changed` event.
 */
export function registerTempoRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  const current = (songId: string): SongTempo => {
    const t = songTempo(db, songId);
    if (!t) throw new AppError("INTERNAL", "Tempo map vanished");
    return t;
  };

  const changed = (
    request: FastifyRequest,
    access: Access,
    action: "set" | "import" | "restore" | "delete",
    details: Record<string, unknown>,
  ) => {
    logChanged(request, access, action, details);
    publishChanged(access);
  };

  const logChanged = (
    request: FastifyRequest,
    access: Access,
    action: "set" | "import" | "restore" | "delete",
    details: Record<string, unknown>,
  ) => {
    audit(db, request, {
      action: "tempo.changed",
      projectId: access.project.id,
      songId: access.song.id,
      targetType: "song",
      targetId: access.song.id,
      details: { action, ...details },
    });
  };

  const publishChanged = (access: Access) => {
    const timelineRev = songTimelineRev(db, access.song.id);
    ctx.hub.publish({
      type: "tempo.changed",
      projectId: access.project.id,
      songId: access.song.id,
      data: { timelineRev },
    });
    // Musical markers may have moved.
    ctx.hub.publish({
      type: "marker.changed",
      projectId: access.project.id,
      songId: access.song.id,
      data: { markerId: null, timelineRev },
    });
  };

  /** Saves a revision; returns the event details. */
  const save = (access: Access, input: TempoInput, userId: string) => {
    const { moved } = saveSongTempo(db, access.song.id, input, userId);
    return {
      source: input.source,
      segments: input.map.segments.length,
      bpm: input.map.segments[0]?.bpm,
      bar1OffsetSec: input.bar1OffsetSec,
      movedMarkers: moved,
    };
  };

  registerContract(app, getSongTempo, ({ access }) => ({
    tempo: songTempo(db, access.song.id),
    timelineRev: songTimelineRev(db, access.song.id),
  }));

  registerContract(app, putSongTempo, ({ access, body, user }, request) => {
    const details = save(
      access,
      { map: body.map, bar1OffsetSec: body.bar1OffsetSec, source: "manual", midiAssetId: null },
      user.id,
    );
    changed(request, access, "set", details);
    return { tempo: current(access.song.id) };
  });

  registerContract(
    app,
    importSongTempoMidi,
    async ({ access, body, user }, request) => {
      const bytes = Buffer.from(body.data, "base64");
      if (bytes.length > MAX_MIDI_BYTES) throw new AppError("FILE_TOO_LARGE", "MIDI too large");
      const parsed = parseMidiTempo(bytes);
      if (!parsed.ok) throw new AppError(parsed.error, "Cannot import this MIDI file");
      const midi = parsed.value;
      await checkQuotaAndDisk(ctx, user, bytes.length);
      const blob = await storeMidiBlob(db, ctx.storage, ctx.config.tmpDir, bytes);
      // Asset, revision, markers and events commit together (nested transactions are savepoints).
      const created = db.transaction(() => {
        const assetId = createMidiAssetRows(db, blob, body.fileName, user.id);
        const details = save(
          access,
          {
            map: midi.map,
            bar1OffsetSec: midi.bar1OffsetSec,
            source: "midi",
            midiAssetId: assetId,
          },
          user.id,
        );
        // Markers picked in the import dialog, anchored to the music (SPEC §7.2, §7.4).
        const grid = compileTempo({ map: midi.map, bar1OffsetSec: midi.bar1OffsetSec });
        let count = 0;
        for (const index of [...new Set(body.markers)].sort((a, b) => a - b)) {
          const m = midi.markers[index];
          if (!m) continue;
          count++;
          createMarkerRow(
            db,
            access.song.id,
            {
              type: "marker",
              name: m.name || `Marker ${index + 1}`,
              color: m.kind === "cue" ? "orange" : "yellow",
              startSec: Math.max(0, beatToSec(grid, m.beat)),
              anchor: "musical",
            },
            user.id,
            Date.now(),
            grid,
          );
        }
        if (count > 0) {
          audit(db, request, {
            action: "markers.imported",
            projectId: access.project.id,
            songId: access.song.id,
            targetType: "song",
            targetId: access.song.id,
            details: { count, from: "midi", fileName: body.fileName },
          });
        }
        logChanged(request, access, "import", {
          ...details,
          fileName: body.fileName,
          markersImported: count,
          warnings: midi.warnings.map((w) => w.code),
        });
        return count;
      });
      publishChanged(access);
      return { tempo: current(access.song.id), markersCreated: created };
    },
    { bodyLimit: 2 * MAX_MIDI_BYTES },
  );

  registerContract(app, deleteSongTempo, ({ access }, request) => {
    if (deleteTempoRow(db, access.song.id)) changed(request, access, "delete", {});
    return { ok: true as const };
  });

  registerContract(app, listTempoRevisions, ({ access }) => ({
    revisions: listSongTempoRevisions(db, access.song.id),
  }));

  registerContract(app, restoreTempoRevision, ({ access, params, user }, request) => {
    const rev = getTempoRevision(db, access.song.id, params.revisionId);
    if (!rev) throw new AppError("NOT_FOUND", "Revision not found");
    changed(request, access, "restore", { ...save(access, rev, user.id), fromRevision: rev.id });
    return { tempo: current(access.song.id) };
  });
}
