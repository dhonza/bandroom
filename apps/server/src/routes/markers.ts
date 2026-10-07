import {
  createMarkerRow,
  getMarkerRow,
  listMarkers,
  markerById,
  recordSongVisitRow,
  setMarkerDeleted,
  songTimelineRev,
  songTempoGrid,
  songWhatsNew,
  storeClientResponse,
  storedClientResponse,
  updateMarkerRow,
  type MarkerRow,
} from "@bandroom/server-core";
import {
  canActOn,
  createMarker,
  deleteMarker,
  getSongWhatsNew,
  listSongMarkers,
  recordSongVisit,
  restoreMarker,
  updateMarker,
  type EffectiveRole,
  type Marker,
} from "@bandroom/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../context";
import { audit } from "../http/audit";
import { registerContract } from "../http/contracts";
import { AppError } from "../http/errors";

/**
 * Markers and sections (SPEC §7.4) and the song visit / "What's new" banner (SPEC §11.3).
 * Contributors annotate their own items, editors anyone's (`annotate.own|any`).
 */
export function registerMarkerRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  const ownedRow = (id: string, role: EffectiveRole, userId: string): MarkerRow => {
    const row = getMarkerRow(db, id);
    if (!row) throw new AppError("NOT_FOUND", "Marker not found");
    if (!canActOn(role, "annotate", row.createdBy === userId)) {
      throw new AppError("FORBIDDEN", "Not your marker");
    }
    return row;
  };

  const changed = (
    request: FastifyRequest,
    access: { project: { id: string }; song: { id: string } },
    verb: "created" | "updated" | "deleted" | "restored",
    m: Pick<Marker, "id" | "type" | "name">,
    details: Record<string, unknown> = {},
  ) => {
    audit(db, request, {
      action: `${m.type}.${verb}`,
      projectId: access.project.id,
      songId: access.song.id,
      targetType: m.type,
      targetId: m.id,
      details: { name: m.name, ...details },
    });
    ctx.hub.publish({
      type: "marker.changed",
      projectId: access.project.id,
      songId: access.song.id,
      data: { markerId: m.id, timelineRev: songTimelineRev(db, access.song.id) },
    });
  };

  registerContract(app, listSongMarkers, ({ access }) => ({
    markers: listMarkers(db, access.song.id),
    timelineRev: songTimelineRev(db, access.song.id),
  }));

  registerContract(app, createMarker, ({ access, body, user }, request) => {
    const route = "createMarker";
    if (body.requestId) {
      const stored = storedClientResponse(db, user.id, body.requestId, route);
      if (stored !== undefined) return stored as { marker: Marker };
    }
    const grid = songTempoGrid(db, access.song.id);
    const marker = createMarkerRow(db, access.song.id, body, user.id, Date.now(), grid);
    changed(request, access, "created", marker, {
      startSec: marker.startSec,
      endSec: marker.endSec,
    });
    const response = { marker };
    if (body.requestId) storeClientResponse(db, user.id, body.requestId, route, response);
    return response;
  });

  registerContract(app, updateMarker, ({ access, params, body, user }, request) => {
    const row = ownedRow(params.id, access.role, user.id);
    if (row.deletedAt !== null) throw new AppError("NOT_FOUND", "Marker not found");
    const marker = updateMarkerRow(db, row, body, Date.now(), songTempoGrid(db, access.song.id));
    if (!marker) throw new AppError("BAD_REQUEST", "A section must end after it starts");
    changed(request, access, "updated", marker, { changes: Object.keys(body) });
    return { marker };
  });

  registerContract(app, deleteMarker, ({ access, params, user }, request) => {
    const row = ownedRow(params.id, access.role, user.id);
    if (row.deletedAt === null) {
      setMarkerDeleted(db, row, true);
      changed(request, access, "deleted", row);
    }
    return { ok: true as const };
  });

  registerContract(app, restoreMarker, ({ access, params, user }, request) => {
    const row = ownedRow(params.id, access.role, user.id);
    if (row.deletedAt !== null) {
      setMarkerDeleted(db, row, false);
      changed(request, access, "restored", row);
    }
    const marker = markerById(db, row.id);
    if (!marker) throw new AppError("NOT_FOUND", "Marker not found");
    return { marker };
  });

  registerContract(app, getSongWhatsNew, ({ access, user }) =>
    songWhatsNew(db, user.id, access.song.id),
  );

  registerContract(app, recordSongVisit, ({ access, user }) => {
    recordSongVisitRow(db, user.id, access.song.id);
    return { ok: true as const };
  });
}
