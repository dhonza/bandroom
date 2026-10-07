import type { LinkStats } from "@bandroom/shared";
import { and, count, countDistinct, desc, eq, inArray, max } from "drizzle-orm";
import type { Db } from "../../db/connection";
import { events, linkSessions, songs } from "../../db/schema";

/** Stats of a link without visitor events. */
export const EMPTY_LINK_STATS: Readonly<LinkStats> = {
  opens: 0,
  visitors: 0,
  plays: 0,
  downloads: 0,
  comments: 0,
  passwordFailures: 0,
  lastAccessAt: null,
};

const STAT_OF: Record<string, keyof LinkStats | undefined> = {
  "link.opened": "opens",
  "link.played": "plays",
  "asset.downloaded": "downloads",
  "comment.created": "comments",
  "link.password_failed": "passwordFailures",
};

/** Counts of visitor events per link (only `actorType = link` events count). */
export function linkStatsOf(db: Db, linkIds: readonly string[]): Map<string, LinkStats> {
  const out = new Map<string, LinkStats>();
  if (linkIds.length === 0) return out;
  const ids = [...new Set(linkIds)];
  for (const id of ids) out.set(id, { ...EMPTY_LINK_STATS });
  const visitorEvents = and(inArray(events.linkId, ids), eq(events.actorType, "link"));
  for (const r of db
    .select({ linkId: events.linkId, action: events.action, n: count() })
    .from(events)
    .where(visitorEvents)
    .groupBy(events.linkId, events.action)
    .all()) {
    const key = STAT_OF[r.action];
    const s = r.linkId ? out.get(r.linkId) : undefined;
    if (key && s) (s[key] as number) = r.n;
  }
  for (const r of db
    .select({
      linkId: events.linkId,
      visitors: countDistinct(events.linkSessionId),
      last: max(events.ts),
    })
    .from(events)
    .where(visitorEvents)
    .groupBy(events.linkId)
    .all()) {
    const s = r.linkId ? out.get(r.linkId) : undefined;
    if (s) {
      s.visitors = r.visitors;
      s.lastAccessAt = r.last;
    }
  }
  return out;
}

/** Newest visitor events of a link with the visitor's name (bounded). */
export function linkRecentActivity(db: Db, linkId: string, limit = 100) {
  return db
    .select({
      id: events.id,
      ts: events.ts,
      action: events.action,
      linkSessionId: events.linkSessionId,
      visitorName: linkSessions.anonymousName,
      songId: events.songId,
      songTitle: songs.title,
      details: events.details,
    })
    .from(events)
    .leftJoin(linkSessions, eq(linkSessions.id, events.linkSessionId))
    .leftJoin(songs, eq(songs.id, events.songId))
    .where(and(eq(events.linkId, linkId), eq(events.actorType, "link")))
    .orderBy(desc(events.ts), desc(events.id))
    .limit(limit)
    .all();
}

/** Plays, downloads and comments per song of one link. */
export function linkSongStats(db: Db, linkId: string) {
  const rows = db
    .select({ songId: events.songId, action: events.action, n: count() })
    .from(events)
    .where(
      and(
        eq(events.linkId, linkId),
        eq(events.actorType, "link"),
        inArray(events.action, ["link.played", "asset.downloaded", "comment.created"]),
      ),
    )
    .groupBy(events.songId, events.action)
    .all();
  const bySong = new Map<string, { plays: number; downloads: number; comments: number }>();
  for (const r of rows) {
    if (!r.songId) continue;
    const s = bySong.get(r.songId) ?? { plays: 0, downloads: 0, comments: 0 };
    if (r.action === "link.played") s.plays = r.n;
    else if (r.action === "asset.downloaded") s.downloads = r.n;
    else s.comments = r.n;
    bySong.set(r.songId, s);
  }
  return bySong;
}
