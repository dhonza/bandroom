import { schema, songIsEditing, type JobContext } from "@bandroom/server-core";
import { uuidv7 } from "@bandroom/shared";
import { and, isNull, sql } from "drizzle-orm";
import type { SamplyComment } from "./api";
import type { Reporter } from "./report";
import { liveLocal, liveLocalOfRun, recordMapping } from "./store";

export const EDITING_REASON = "The song is being edited (SONG_EDITING)";

export function importComments(
  ctx: JobContext,
  runId: string,
  rep: Reporter,
  list: SamplyComment[],
  opts: {
    dry: boolean;
    songId: string | null;
    trackId: string | null;
    context: Record<string, unknown>;
    songTitle: string;
  },
): void {
  const { db } = ctx;
  const usersByEmail = new Map<string, string>();
  const userFor = (email: string | null | undefined): string | null => {
    const e = email?.trim().toLowerCase();
    if (!e) return null;
    if (!usersByEmail.has(e)) {
      const u = db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(and(sql`lower(${schema.users.email}) = ${e}`, isNull(schema.users.deletedAt)))
        .get();
      usersByEmail.set(e, u?.id ?? "");
    }
    return usersByEmail.get(e) || null;
  };
  // Parents before replies so parent ids resolve.
  const ordered = [...list].sort(
    (a, b) => Number(Boolean(a.parentid)) - Number(Boolean(b.parentid)),
  );
  for (const c of ordered) {
    const name = `${opts.songTitle}: ${c.message.slice(0, 40)}`;
    const existing = liveLocalOfRun(db, "comment", c.id, "comment", runId);
    if (existing) {
      // A retried attempt of this run reports what its failed attempt imported as imported.
      const outcome = existing.thisRun ? "imported" : "existing";
      rep.item({ kind: "comment", name, outcome, reason: null });
      continue;
    }
    const author = userFor(c.creator?.email);
    const authorName = c.creator?.displayName?.trim() || c.creator?.email || "Samply user";
    if (!author && !rep.report.unmatchedAuthors.some((a) => a.name === authorName)) {
      rep.report.unmatchedAuthors.push({ name: authorName, email: c.creator?.email ?? null });
    }
    if (opts.dry || !opts.songId) {
      rep.item({ kind: "comment", name, outcome: "planned", reason: null });
      continue;
    }
    // An edit session freezes the song's comments (SPEC §24.7); a later run imports them.
    if (songIsEditing(db, opts.songId)) {
      rep.item({ kind: "comment", name, outcome: "failed", reason: EDITING_REASON });
      continue;
    }
    const parentId = c.parentid ? liveLocal(db, "comment", c.parentid, "comment") : null;
    const start = c.audioTimestamp ?? null;
    const end =
      c.audioTimestampEnd !== null &&
      c.audioTimestampEnd !== undefined &&
      start !== null &&
      c.audioTimestampEnd > start
        ? c.audioTimestampEnd
        : null;
    const created = c.timeCreated ?? Date.now();
    const id = uuidv7(created);
    db.insert(schema.comments)
      .values({
        id,
        songId: opts.songId,
        trackId: opts.trackId,
        parentId,
        authorUserId: author,
        importedAuthorName: author ? null : authorName.slice(0, 120),
        body: c.message.slice(0, 10_000),
        startSec: start,
        endSec: end,
        context: JSON.stringify(opts.context),
        source: "import",
        resolvedAt: c.completed ? (c.timeModified ?? created) : null,
        createdAt: created,
        editedAt: c.timeModified && c.timeModified > created + 1000 ? c.timeModified : null,
      })
      .run();
    for (const [emoji, r] of Object.entries(c.reactions ?? {})) {
      for (const u of Object.values(r.users ?? {})) {
        const userId = userFor(u.email);
        if (!userId) continue;
        db.insert(schema.commentReactions)
          .values({ id: uuidv7(), commentId: id, userId, emoji, createdAt: created })
          .onConflictDoNothing()
          .run();
      }
    }
    recordMapping(db, {
      externalType: "comment",
      externalId: c.id,
      localType: "comment",
      localId: id,
      runId,
    });
    rep.item({ kind: "comment", name, outcome: "imported", reason: null });
  }
}
