import type { Comment, CommentReply } from "@bandroom/shared";
import { describe, expect, it } from "vitest";
import { matchMentionable } from "./CommentEditor";
import {
  authorColor,
  authorsOf,
  composerPayload,
  contextDiff,
  DEFAULT_FILTERS,
  filterComments,
  initials,
  laneComments,
  mentionUsernames,
  openCount,
  sortComments,
} from "./model";

const author = (userId: string | null, name: string) => ({
  userId,
  name,
  username: userId,
  kind: userId ? ("user" as const) : ("imported" as const),
});

function reply(id: string, over: Partial<CommentReply> = {}): CommentReply {
  return {
    id,
    songId: "s",
    trackId: null,
    parentId: "p",
    author: author("u1", "Petr"),
    body: "x",
    startSec: null,
    endSec: null,
    context: { trackVersions: {}, tempoRev: null },
    source: "app",
    resolvedAt: null,
    resolvedByName: null,
    createdAt: 1,
    editedAt: null,
    deleted: false,
    reactions: [],
    mentions: [],
    ...over,
  };
}
const comment = (id: string, over: Partial<Comment> = {}): Comment => ({
  ...reply(id, { parentId: null }),
  replies: [],
  ...over,
});

const list: Comment[] = [
  comment("a", { startSec: 30, createdAt: 10, trackId: "bass" }),
  comment("b", { startSec: 5, createdAt: 20, resolvedAt: 25 }),
  comment("c", {
    startSec: null,
    createdAt: 5,
    author: author(null, "Old Friend"),
    replies: [reply("r", { createdAt: 50, mentions: ["me"], author: author("u2", "Vera") })],
  }),
];

describe("comment filters and sorting (SPEC §8)", () => {
  it("hides resolved comments by default and filters by author, track and mentions", () => {
    const ids = (f: Partial<typeof DEFAULT_FILTERS>) =>
      filterComments(list, { ...DEFAULT_FILTERS, ...f }, "me").map((c) => c.id);
    expect(ids({})).toEqual(["a", "c"]);
    expect(ids({ showResolved: true })).toEqual(["a", "b", "c"]);
    expect(ids({ author: "user:u2" })).toEqual(["c"]);
    expect(ids({ author: "name:Old Friend" })).toEqual(["c"]);
    expect(ids({ track: "bass" })).toEqual(["a"]);
    expect(ids({ track: "song" })).toEqual(["c"]);
    expect(ids({ mentionsMe: true })).toEqual(["c"]);
  });

  it("sorts by time in song (general first) or by latest activity", () => {
    expect(sortComments(list, "time").map((c) => c.id)).toEqual(["c", "b", "a"]);
    expect(sortComments(list, "date").map((c) => c.id)).toEqual(["c", "b", "a"]);
    expect(sortComments(list.slice(0, 2), "date").map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("lists authors including repliers, and derives stable colors and initials", () => {
    expect(authorsOf(list).map((a) => a.name)).toEqual(["Old Friend", "Petr", "Vera"]);
    expect(authorColor(author("u1", "Petr"))).toBe(authorColor(author("u1", "Other name")));
    expect(initials("Jan Novák")).toBe("JN");
    expect(initials("petr")).toBe("P");
    expect(initials("  ")).toBe("?");
  });

  it("puts positioned, open comments on the lane and counts open ones", () => {
    expect(laneComments(list, false).map((c) => c.id)).toEqual(["a"]);
    expect(laneComments(list, true).map((c) => c.id)).toEqual(["a", "b"]);
    expect(openCount([...list, comment("d", { deleted: true })])).toBe(2);
  });
});

describe("context diff (SPEC §8 'written on Bass v3')", () => {
  it("lists tracks whose version differs from the loaded one", () => {
    const ctx = { trackVersions: { bass: "v3", mix: "v5", gone: "x" }, tempoRev: null };
    expect(contextDiff(ctx, { bass: "v4", mix: "v5" })).toEqual([
      { trackId: "bass", versionId: "v3" },
    ]);
    expect(contextDiff(ctx, { bass: "v3", mix: "v5" })).toEqual([]);
  });
});

describe("mention autocomplete", () => {
  it("matches usernames and words of display names", () => {
    const users = [
      { id: "1", username: "petr", displayName: "Petr Novák" },
      { id: "2", username: "vera", displayName: "Věra Nováková" },
      { id: "3", username: "jan", displayName: "Jan" },
    ];
    expect(matchMentionable(users, "no").map((u) => u.id)).toEqual(["1", "2"]);
    expect(matchMentionable(users, "j").map((u) => u.id)).toEqual(["3"]);
    expect(matchMentionable(users, "")).toHaveLength(3);
  });
});

describe("mentions and the composer", () => {
  it("highlights mentions of the song's users, else of the authors", () => {
    expect(mentionUsernames([{ username: "jana" }], list)).toEqual(["jana"]);
    expect(mentionUsernames(undefined, list)).toEqual(["u1", "u1", "u2"]);
  });

  it("posts the range when chosen, else the captured time", () => {
    const draft = { startSec: 12, range: { start: 3, end: 8 }, useRange: true, trackId: "t" };
    const versions = { t: "v1" };
    expect(composerPayload(draft, "hi", versions)).toEqual({
      body: "hi",
      startSec: 3,
      endSec: 8,
      trackId: "t",
      context: { trackVersions: versions },
    });
    expect(composerPayload({ ...draft, useRange: false }, "hi", {})).toMatchObject({
      startSec: 12,
      endSec: null,
    });
    expect(
      composerPayload({ startSec: null, range: null, useRange: true, trackId: null }, "x", {}),
    ).toMatchObject({ startSec: null, endSec: null, trackId: null });
  });
});
