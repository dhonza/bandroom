import {
  bytesByProject,
  bytesBySong,
  createProjectRow,
  createSongRow,
  followTarget,
  getUserById,
  listVisibleProjects,
  listVisibleSongs,
  lossyBySong,
  projectGrantRows,
  noProcessing,
  processingBySong,
  projectImageHash,
  removeProjectGrantRow,
  reorderSongRows,
  setProjectGrantRow,
  softDeleteProject,
  toProject,
  toProjectSummary,
  toSongSummary,
  updateProjectRow,
  type Db,
  type ProjectPatch,
  type ProjectRow,
  type UserRow,
} from "@bandroom/server-core";
import {
  createProject,
  createSong,
  deleteProject,
  getProject,
  listProjectGrants,
  listProjects,
  listProjectSongs,
  removeProjectGrant,
  reorderSongs,
  setProjectGrant,
  transferProjectOwnership,
  updateProject,
  type EffectiveRole,
} from "@bandroom/shared";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context";
import { audit } from "../http/audit";
import { registerContract } from "../http/contracts";
import { AppError } from "../http/errors";
import { notifyGranted, notifyNewSong } from "../notify";

function projectDto(
  db: Db,
  user: UserRow,
  p: ProjectRow,
  role: EffectiveRole,
  visibility: "full" | "reduced",
) {
  return {
    ...toProject(db, p, role, visibility, listVisibleSongs(db, user, p.id).length),
    // Sizes only for the full view: the reduced view must not reveal hidden songs (SPEC §28.6).
    bytes: visibility === "full" ? (bytesByProject(db, [p.id]).get(p.id) ?? 0) : null,
  };
}

export function registerProjectRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  registerContract(app, listProjects, ({ query, user }) => {
    const visible = listVisibleProjects(db, user, { archived: query.archived === "true" });
    const bytes = bytesByProject(
      db,
      visible.filter((v) => v.visibility === "full").map((v) => v.project.id),
    );
    return {
      projects: visible.map((v) => ({
        ...toProjectSummary(
          v.project,
          v.role,
          v.visibility,
          v.visibleSongCount,
          projectImageHash(db, v.project),
        ),
        bytes: v.visibility === "full" ? (bytes.get(v.project.id) ?? 0) : null,
      })),
    };
  });

  registerContract(app, createProject, ({ body, user }, request) => {
    const project = createProjectRow(db, { ...body, createdBy: user.id });
    audit(db, request, {
      action: "project.created",
      projectId: project.id,
      targetType: "project",
      targetId: project.id,
      details: { name: project.name },
    });
    followTarget(db, user.id, "project", project.id); // creators follow what they create
    return { project: projectDto(db, user, project, "manager", "full") };
  });

  registerContract(app, getProject, ({ user, access }) => {
    return { project: projectDto(db, user, access.project, access.role, access.visibility) };
  });

  registerContract(app, updateProject, ({ body, user, access }, request) => {
    const { archived, ...rest } = body;
    const patch: ProjectPatch = { ...rest };
    const p = access.project;
    if (archived === true && p.archivedAt === null) patch.archivedAt = Date.now();
    if (archived === false) patch.archivedAt = null;
    const updated = updateProjectRow(db, p.id, patch);
    const base = { projectId: p.id, targetType: "project", targetId: p.id } as const;
    if (Object.keys(rest).length > 0) {
      audit(db, request, {
        ...base,
        action: "project.updated",
        details: { changes: Object.keys(rest) },
      });
    }
    if (patch.archivedAt !== undefined) {
      audit(db, request, {
        ...base,
        action: patch.archivedAt === null ? "project.unarchived" : "project.archived",
      });
    }
    return { project: projectDto(db, user, updated, access.role, "full") };
  });

  registerContract(app, deleteProject, ({ user, access }, request) => {
    // Published first: once the project is deleted nobody can see project-scoped events any more.
    // Open players drop its songs (SPEC §6.10); clients refetch after the delete is done.
    ctx.hub.publish({
      type: "project.deleted",
      projectId: access.project.id,
      data: { projectId: access.project.id },
    });
    softDeleteProject(db, access.project.id, Date.now(), user.id);
    audit(db, request, {
      action: "project.deleted",
      projectId: access.project.id,
      targetType: "project",
      targetId: access.project.id,
      details: { name: access.project.name },
    });
    return { ok: true as const };
  });

  registerContract(app, transferProjectOwnership, ({ body, user, access }, request) => {
    const target = getUserById(db, body.userId);
    if (!target || target.disabledAt !== null) throw new AppError("NOT_FOUND", "User not found");
    const p = access.project;
    const updated = db.transaction(() => {
      setProjectGrantRow(db, p.id, target.id, "manager", user.id);
      return updateProjectRow(db, p.id, { ownerId: target.id });
    });
    audit(db, request, {
      action: "project.ownership_transferred",
      projectId: p.id,
      targetType: "project",
      targetId: p.id,
      details: { from: p.ownerId, to: target.id },
    });
    return { project: projectDto(db, user, updated, access.role, "full") };
  });

  registerContract(app, listProjectSongs, ({ user, access }) => {
    const processing = processingBySong(db, access.project.id);
    const lossy = lossyBySong(db, access.project.id);
    const bytes = bytesBySong(db, access.project.id);
    return {
      songs: listVisibleSongs(db, user, access.project.id).map((s) => ({
        ...toSongSummary(s.song, s.role),
        processing: processing.get(s.song.id) ?? noProcessing(),
        lossy: lossy.get(s.song.id) ?? "none",
        bytes: bytes.get(s.song.id) ?? 0,
      })),
    };
  });

  registerContract(app, createSong, ({ body, user, access }, request) => {
    const song = createSongRow(db, { ...body, projectId: access.project.id, createdBy: user.id });
    audit(db, request, {
      action: "song.created",
      projectId: song.projectId,
      songId: song.id,
      targetType: "song",
      targetId: song.id,
      details: { title: song.title },
    });
    notifyNewSong(ctx, { actor: user, project: access.project, song });
    return { song: toSongSummary(song, access.role) };
  });

  registerContract(app, reorderSongs, ({ body, access }, request) => {
    reorderSongRows(db, access.project.id, body.songIds);
    audit(db, request, {
      action: "songs.reordered",
      projectId: access.project.id,
      targetType: "project",
      targetId: access.project.id,
    });
    // Other open project pages follow the new order (like track reorders, SPEC §28.5).
    ctx.hub.publish({
      type: "project.updated",
      projectId: access.project.id,
      data: { projectId: access.project.id },
    });
    return { ok: true as const };
  });

  registerContract(app, listProjectGrants, ({ access }) => ({
    grants: projectGrantRows(db, access.project.id),
  }));

  registerContract(app, setProjectGrant, ({ params, body, user, access }, request) => {
    const target = getUserById(db, params.userId);
    if (!target) throw new AppError("NOT_FOUND", "User not found");
    const before = setProjectGrantRow(db, access.project.id, target.id, body.role, user.id);
    audit(db, request, {
      action: "grant.changed",
      projectId: access.project.id,
      targetType: "user",
      targetId: target.id,
      details: { scope: "project", before, after: body.role },
    });
    notifyGranted(ctx, {
      actor: user,
      granteeId: target.id,
      project: access.project,
      song: null,
      before,
      after: body.role,
    });
    return { ok: true as const };
  });

  registerContract(app, removeProjectGrant, ({ params, access }, request) => {
    const before = removeProjectGrantRow(db, access.project.id, params.userId);
    if (before !== null) {
      audit(db, request, {
        action: "grant.changed",
        projectId: access.project.id,
        targetType: "user",
        targetId: params.userId,
        details: { scope: "project", before, after: null },
      });
    }
    return { ok: true as const };
  });
}
