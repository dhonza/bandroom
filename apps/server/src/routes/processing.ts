import { processingBySong, resolveSongAccess } from "@bandroom/server-core";
import {
  getProcessing,
  hasGlobalCapability,
  roleAtLeast,
  type ProcessingSong,
} from "@bandroom/shared";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context";
import { registerContract } from "../http/contracts";
import { activeRuns } from "../importers/samply/store";

/**
 * `GET /processing` (SPEC §25.3): songs with media work that the user can see, and for admins the
 * running Samply scans and imports.
 */
export function registerProcessingRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  registerContract(app, getProcessing, ({ user }) => {
    const songs: (ProcessingSong & { order: [string, number] })[] = [];
    for (const [songId, processing] of processingBySong(db)) {
      const access = resolveSongAccess(db, user, songId);
      if (!access || !roleAtLeast(access.role, "viewer")) continue;
      songs.push({
        songId,
        title: access.song.title,
        projectId: access.project.id,
        projectName: access.project.name,
        processing,
        order: [access.project.name, access.song.sortOrder],
      });
    }
    songs.sort((a, b) => a.order[0].localeCompare(b.order[0]) || a.order[1] - b.order[1]);
    const imports = hasGlobalCapability(user, "admin.access")
      ? activeRuns(db).map((r) => ({
          id: r.id,
          status: r.status,
          dryRun: r.dryRun,
          progress: r.progress,
        }))
      : [];
    return { songs: songs.map(({ order: _order, ...s }) => s), imports };
  });
}
