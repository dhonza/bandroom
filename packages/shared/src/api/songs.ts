import { z } from "zod";
import { GrantRowSchema, SongSchema, SongTitleSchema } from "../content";
import { ContentRoleSchema, SongDownloadPolicySchema } from "../permissions/content";
import { OkSchema } from "./auth";
import { defineContract } from "./contract";

const IdParams = z.object({ id: z.string().min(1).max(64) });
const GrantParams = z.object({ id: z.string().min(1).max(64), userId: z.string().min(1).max(64) });

export const getSong = defineContract({
  method: "GET",
  path: "/songs/:id",
  params: IdParams,
  response: z.object({ song: SongSchema }),
  errors: ["NOT_FOUND"],
  auth: { capability: "view", scope: "song" },
});

export const updateSong = defineContract({
  method: "PATCH",
  path: "/songs/:id",
  params: IdParams,
  body: z
    .object({
      title: SongTitleSchema,
      subtitle: z.string().trim().max(200),
      key: z.string().trim().max(40),
      notes: z.string().max(20_000),
      downloadPolicy: SongDownloadPolicySchema,
    })
    .partial(),
  response: z.object({ song: SongSchema }),
  auth: { capability: "edit.any", scope: "song" },
});

export const deleteSong = defineContract({
  method: "DELETE",
  path: "/songs/:id",
  params: IdParams,
  response: OkSchema,
  auth: { capability: "song.delete", scope: "song" },
});

export const listSongGrants = defineContract({
  method: "GET",
  path: "/songs/:id/grants",
  params: IdParams,
  response: z.object({ grants: z.array(GrantRowSchema) }),
  auth: { capability: "grants.manage", scope: "song" },
});

export const setSongGrant = defineContract({
  method: "PUT",
  path: "/songs/:id/grants/:userId",
  params: GrantParams,
  body: z.object({ role: ContentRoleSchema }),
  response: OkSchema,
  errors: ["NOT_FOUND"],
  auth: { capability: "grants.manage", scope: "song" },
});

export const removeSongGrant = defineContract({
  method: "DELETE",
  path: "/songs/:id/grants/:userId",
  params: GrantParams,
  response: OkSchema,
  auth: { capability: "grants.manage", scope: "song" },
});

/**
 * Locks the song (SPEC §25.12): markers and sections, comments, the default mix, version gain
 * and the tempo map are frozen for everyone until an editor unlocks it. Idempotent.
 */
export const lockSong = defineContract({
  method: "POST",
  path: "/songs/:id/lock",
  params: IdParams,
  response: z.object({ song: SongSchema }),
  auth: { capability: "edit.any", scope: "song" },
});

export const unlockSong = defineContract({
  method: "POST",
  path: "/songs/:id/unlock",
  params: IdParams,
  response: z.object({ song: SongSchema }),
  auth: { capability: "edit.any", scope: "song" },
});
