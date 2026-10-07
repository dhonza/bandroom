import {
  applyLosslessRemoval,
  enqueueBlobGc,
  getSetting,
  listTrashRows,
  planLosslessRemoval,
  projectRoleOf,
  purgeTrashItems,
  restoreDocumentRow,
  restoreProjectRow,
  restoreSongRow,
  restoreTrackRow,
  restoreTrackVersionRow,
  softDeleteSong,
  softDeleteTrack,
  softDeleteTrackVersion,
  songRoleOf,
  trashItemStorage,
  type TrashRow,
  type UserRow,
} from "@bandroom/server-core";
import {
  batchDelete,
  batchPurge,
  batchRemoveLossless,
  batchRemoveLosslessPreview,
  batchRestore,
  canPurgeContainer,
  canPurgeContent,
  canRestoreContainer,
  canRestoreContent,
  listAdminTrash,
  listProjectTrash,
  roleAtLeast,
  uuidv7,
  type EffectiveRole,
  type EventAction,
  type TrashItem,
  type TrashKind,
  type TrashListKind,
} from "@bandroom/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../context";
import { audit } from "../http/audit";
import type { BatchContainer, BatchItem } from "../http/batch";
import { registerContract } from "../http/contracts";
import { AppError } from "../http/errors";

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Batch writes run in immediate transactions: their reads and writes see one snapshot even while
 * the worker writes (a deferred transaction can fail with SQLITE_BUSY_SNAPSHOT when upgrading).
 */
const IMMEDIATE = { behavior: "immediate" } as const;
const TARGET_TYPE: Record<TrashListKind, string> = {
  song: "song",
  track: "track",
  version: "trackVersion",
  project: "project",
  document: "document",
};

/** Batch delete/restore/purge, remove full quality and the Trash lists (SPEC §26.2–§26.4). */
export function registerBatchRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  const log = (
    request: FastifyRequest,
    item: BatchItem,
    verb: "deleted" | "restored",
    batchId: string,
  ) => {
    const action = `${item.kind}.${verb}` as EventAction;
    audit(db, request, {
      action,
      projectId: item.project.id,
      songId: item.song.id,
      targetType: TARGET_TYPE[item.kind],
      targetId: item.id,
      details: {
        batchId,
        ...(item.kind === "song" && { title: item.song.title }),
        ...(item.kind === "track" && { name: item.track?.name }),
        ...(item.kind === "version" && { trackId: item.track?.id, number: item.version?.number }),
      },
    });
  };

  /**
   * SSE as the single-item routes send it. Song events are project-scoped (a deleted song is no
   * longer visible, so a song-scoped event would reach nobody); open pages get the id in `data`.
   */
  const publish = (item: BatchItem, verb: "deleted" | "restored") => {
    const projectId = item.project.id;
    if (item.kind === "song") {
      ctx.hub.publish({ type: `song.${verb}`, projectId, data: { songId: item.id } });
    } else if (item.kind === "track") {
      ctx.hub.publish({
        type: `track.${verb}`,
        projectId,
        songId: item.song.id,
        data: { trackId: item.id },
      });
    } else {
      ctx.hub.publish({
        type: `version.${verb}`,
        projectId,
        songId: item.song.id,
        data: { trackId: item.track?.id, versionId: item.id },
      });
    }
  };

  registerContract(app, batchDelete, ({ user, access }, request) => {
    const batchId = uuidv7();
    const now = Date.now();
    db.transaction(() => {
      for (const item of access.items) {
        if (item.kind === "song") softDeleteSong(db, item.song, now, user.id);
        else if (item.kind === "track") softDeleteTrack(db, item.id, now, user.id);
        else softDeleteTrackVersion(db, item.id, now, user.id);
        log(request, item, "deleted", batchId);
      }
      // Immediate, like every batch write: one snapshot while the worker writes (SPEC §26.2).
    }, IMMEDIATE);
    for (const item of access.items) publish(item, "deleted");
    return { ok: true as const, batchId, count: access.items.length };
  });

  /** Events and SSE of a restored or purged project or document (SPEC §26.3). */
  const logContainer = (
    request: FastifyRequest,
    c: { kind: TrashListKind; id: string; projectId: string; songId: string | null; name: string },
    verb: "restored" | "purged",
    batchId: string,
  ) => {
    audit(db, request, {
      action: `${c.kind}.${verb}` as EventAction,
      projectId: c.projectId,
      songId: c.songId,
      targetType: TARGET_TYPE[c.kind],
      targetId: c.id,
      details: { batchId, name: c.name },
    });
  };
  const publishContainer = (c: BatchContainer) => {
    if (c.kind === "project") {
      // Members' libraries get it back; the admin Trash refreshes (unscoped: admins only).
      ctx.hub.publish({ type: "project.updated", projectId: c.id, data: { projectId: c.id } });
      ctx.hub.publish({ type: "trash.changed", data: {} });
    } else {
      ctx.hub.publish({
        type: "document.changed",
        projectId: c.project.id,
        songId: null,
        data: { documentId: c.id },
      });
    }
  };

  registerContract(app, batchRestore, ({ access }, request) => {
    const restoring = new Set(access.items.map((i) => `${i.kind}:${i.id}`));
    // A track, version or document cannot come back into a song (or track) still in the Trash.
    const blocked = [
      ...access.items.filter(
        (i) =>
          (i.kind !== "song" && i.song.deletedAt !== null && !restoring.has(`song:${i.song.id}`)) ||
          (i.kind === "version" &&
            i.track?.deletedAt != null &&
            !restoring.has(`track:${i.track.id}`)),
      ),
    ];
    if (blocked.length > 0) {
      throw new AppError("TRASH_PARENT_DELETED", "Restore the song first", {
        ids: blocked.map((i) => i.id).join(","),
        count: blocked.length,
      });
    }
    const batchId = uuidv7();
    const now = Date.now();
    const order: TrashKind[] = ["song", "track", "version"];
    const sorted = [...access.items].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    db.transaction(() => {
      for (const item of sorted) {
        if (item.kind === "song") restoreSongRow(db, item.id, now);
        else if (item.kind === "track") restoreTrackRow(db, item.id, now);
        else restoreTrackVersionRow(db, item.id, now);
        log(request, item, "restored", batchId);
      }
      for (const c of access.containers) {
        if (c.kind === "project") restoreProjectRow(db, c.id, now);
        else restoreDocumentRow(db, c.id);
        logContainer(
          request,
          {
            kind: c.kind,
            id: c.id,
            projectId: c.project.id,
            songId: null,
            name: c.document?.title ?? c.project.name,
          },
          "restored",
          batchId,
        );
      }
    }, IMMEDIATE);
    for (const item of sorted) publish(item, "restored");
    for (const c of access.containers) publishContainer(c);
    return {
      ok: true as const,
      batchId,
      count: access.items.length + access.containers.length,
    };
  });

  registerContract(app, batchPurge, ({ access }, request) => {
    const batchId = uuidv7();
    const now = Date.now();
    const ids = (kind: TrashKind) => access.items.filter((i) => i.kind === kind).map((i) => i.id);
    const containerIds = (kind: "project" | "document") =>
      access.containers.filter((c) => c.kind === kind).map((c) => c.id);
    const result = db.transaction(() => {
      const r = purgeTrashItems(
        db,
        {
          songs: ids("song"),
          tracks: ids("track"),
          versions: ids("version"),
          projects: containerIds("project"),
          documents: containerIds("document"),
        },
        now,
      );
      // The files go within minutes, not with the daily GC (SPEC §26.3).
      enqueueBlobGc(db, r.releasedHashes, ctx.config.purgeGcGraceMs, now);
      for (const p of r.purged) {
        audit(db, request, {
          action: `${p.kind}.purged` as EventAction,
          projectId: p.projectId,
          songId: p.songId,
          targetType: TARGET_TYPE[p.kind],
          targetId: p.id,
          details: { batchId, name: p.name },
        });
      }
      return r;
    }, IMMEDIATE);
    const gone = new Set(result.purged.filter((p) => p.kind === "project").map((p) => p.id));
    for (const projectId of new Set(result.purged.map((p) => p.projectId)))
      if (!gone.has(projectId)) ctx.hub.publish({ type: "trash.changed", projectId, data: {} });
    // A purged project is only in the admin Trash (unscoped: admins only).
    if (gone.size > 0) ctx.hub.publish({ type: "trash.changed", data: {} });
    return {
      ok: true as const,
      batchId,
      count: result.purged.length,
      bytesFreed: result.bytesFreed,
    };
  });

  registerContract(
    app,
    batchRemoveLosslessPreview,
    ({ access }) => planLosslessRemoval(db, access.items).preview,
  );

  registerContract(app, batchRemoveLossless, ({ user, access }, request) => {
    const batchId = uuidv7();
    const now = Date.now();
    const { plan, archived } = db.transaction(
      () => {
        const p = planLosslessRemoval(db, access.items);
        const a = applyLosslessRemoval(db, p, user.id, now);
        for (const v of a) {
          audit(db, request, {
            action: "version.lossless_removed",
            projectId: v.projectId,
            songId: v.songId,
            targetType: "trackVersion",
            targetId: v.versionId,
            details: {
              batchId,
              trackId: v.trackId,
              number: v.number,
              ...(v.copy && { copy: true }),
            },
          });
        }
        return { plan: p, archived: a };
        // Immediate: the plan's reads and the writes see one snapshot even while the worker writes
        // (a deferred transaction would fail with SQLITE_BUSY_SNAPSHOT when upgrading).
      },
      { behavior: "immediate" },
    );
    // Open song pages and lists refresh (badges, download menus).
    const bySong = new Map<string, { projectId: string; versionIds: string[] }>();
    for (const v of archived) {
      const e = bySong.get(v.songId) ?? { projectId: v.projectId, versionIds: [] };
      e.versionIds.push(v.versionId);
      bySong.set(v.songId, e);
    }
    for (const [songId, e] of bySong) {
      ctx.hub.publish({
        type: "version.lossless_removed",
        projectId: e.projectId,
        songId,
        data: { versionIds: e.versionIds },
      });
    }
    return {
      ok: true as const,
      batchId,
      count: plan.targets.length,
      usageBytes: plan.preview.usageBytes,
      bytesFreed: plan.preview.bytesFreed,
    };
  });

  const retentionDays = () => getSetting(db, "trash.retentionDays");

  /** Trash rows the user can see, with what they may do (SPEC §26.3). */
  const toItems = (user: UserRow, rows: TrashRow[]): TrashItem[] => {
    const days = retentionDays();
    const roles = new Map<string, EffectiveRole>();
    const roleFor = (row: TrashRow) => {
      const key = row.song ? `s:${row.song.id}` : `p:${row.project.id}`;
      let role = roles.get(key);
      if (role === undefined) {
        role = row.song ? songRoleOf(db, user, row.song) : projectRoleOf(db, user, row.project.id);
        roles.set(key, role);
      }
      return role;
    };
    const may = (row: TrashRow, role: EffectiveRole, own: boolean) =>
      row.kind === "project" || row.kind === "document"
        ? {
            canRestore: canRestoreContainer(role, row.kind, own),
            canPurge: canPurgeContainer(role, row.kind),
          }
        : {
            canRestore: canRestoreContent(role, row.kind, own),
            canPurge: canPurgeContent(role, row.kind, own),
          };
    return rows.flatMap((row) => {
      const role = roleFor(row);
      if (!roleAtLeast(role, "viewer")) return [];
      const own = row.ownerId === user.id;
      const storage = trashItemStorage(db, row.kind, row.id);
      return [
        {
          kind: row.kind,
          id: row.id,
          name: row.name,
          number: row.number,
          project: { id: row.project.id, name: row.project.name },
          song: row.song && {
            id: row.song.id,
            title: row.song.title,
            deleted: row.song.deletedAt !== null,
          },
          track: row.track && {
            id: row.track.id,
            name: row.track.name,
            deleted: row.track.deletedAt !== null,
          },
          deletedAt: row.deletedAt,
          deletedBy: row.deletedBy,
          purgeAt: row.deletedAt + days * DAY_MS,
          bytes: storage.bytes,
          shared: storage.shared,
          ...may(row, role, own),
        },
      ];
    });
  };

  registerContract(app, listProjectTrash, ({ user, access }) => ({
    items: toItems(user, listTrashRows(db, access.project.id)),
    retentionDays: retentionDays(),
  }));

  registerContract(app, listAdminTrash, ({ user }) => ({
    items: toItems(user, listTrashRows(db)),
    retentionDays: retentionDays(),
  }));
}
