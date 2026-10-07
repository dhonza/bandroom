import { MixerStateSchema, uuidv7, type MixerSnapshot, type MixerState } from "@bandroom/shared";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/connection";
import { mixerSnapshots, mixerStates } from "../db/schema";

/** Stored JSON that no longer parses (e.g. after a schema change) reads as "no state". */
function parseState(json: string): MixerState | null {
  try {
    const r = MixerStateSchema.safeParse(JSON.parse(json));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export function getMixerState(db: Db, userId: string, songId: string): MixerState | null {
  const row = db
    .select({ state: mixerStates.state })
    .from(mixerStates)
    .where(and(eq(mixerStates.userId, userId), eq(mixerStates.songId, songId)))
    .get();
  return row ? parseState(row.state) : null;
}

export function putMixerState(db: Db, userId: string, songId: string, state: MixerState): void {
  const now = Date.now();
  const json = JSON.stringify(state);
  db.insert(mixerStates)
    .values({ userId, songId, state: json, updatedAt: now })
    .onConflictDoUpdate({
      target: [mixerStates.userId, mixerStates.songId],
      set: { state: json, updatedAt: now },
    })
    .run();
}

/** Snapshots per user and song are capped so the table cannot grow without bound. */
export const MAX_MIXER_SNAPSHOTS = 50;

export function listMixerSnapshots(db: Db, userId: string, songId: string): MixerSnapshot[] {
  return db
    .select()
    .from(mixerSnapshots)
    .where(and(eq(mixerSnapshots.userId, userId), eq(mixerSnapshots.songId, songId)))
    .orderBy(asc(mixerSnapshots.createdAt))
    .all()
    .flatMap((r) => {
      const state = parseState(r.state);
      return state ? [{ id: r.id, name: r.name, state, createdAt: r.createdAt }] : [];
    });
}

export function createMixerSnapshot(
  db: Db,
  userId: string,
  songId: string,
  name: string,
  state: MixerState,
): MixerSnapshot | null {
  if (listMixerSnapshots(db, userId, songId).length >= MAX_MIXER_SNAPSHOTS) return null;
  const row = {
    id: uuidv7(),
    userId,
    songId,
    name,
    state: JSON.stringify(state),
    createdAt: Date.now(),
  };
  db.insert(mixerSnapshots).values(row).run();
  return { id: row.id, name, state, createdAt: row.createdAt };
}

/** Deletes one of the user's own snapshots; false when it is not theirs or not on this song. */
export function deleteMixerSnapshot(db: Db, userId: string, songId: string, id: string): boolean {
  const r = db
    .delete(mixerSnapshots)
    .where(
      and(
        eq(mixerSnapshots.id, id),
        eq(mixerSnapshots.userId, userId),
        eq(mixerSnapshots.songId, songId),
      ),
    )
    .run();
  return r.changes > 0;
}
