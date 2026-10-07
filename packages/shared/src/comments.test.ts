import { describe, expect, it } from "vitest";
import {
  commentExcerpt,
  commentExportRows,
  commentsToCsv,
  commentsToMarkdown,
  CreateCommentSchema,
  extractMentions,
  formatCommentTime,
  mentionQueryAt,
  parseCommentContext,
  splitMentions,
  type Comment,
} from "./comments";

describe("mentions (SPEC §8)", () => {
  it("extracts unique lowercase usernames, ignoring emails and short tokens", () => {
    expect(
      extractMentions("@Petr check this, @vera.k. and @petr again; mail a@b.cz; @ab; (@jan_2)"),
    ).toEqual(["petr", "vera.k", "jan_2"]);
    expect(extractMentions("no mentions here")).toEqual([]);
  });

  it("splits text into known mentions and plain parts", () => {
    expect(splitMentions("hi @Petr and @nobody.", new Set(["petr"]))).toEqual([
      { text: "hi ", mention: false },
      { text: "@Petr", mention: true },
      { text: " and @nobody.", mention: false },
    ]);
    expect(splitMentions("@vera", new Set(["vera"]))).toEqual([{ text: "@vera", mention: true }]);
  });

  it("finds the mention being typed at the caret", () => {
    expect(mentionQueryAt("hey @Pe", 7)).toEqual({ start: 4, query: "pe" });
    expect(mentionQueryAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQueryAt("mail a@b", 8)).toBeNull();
    expect(mentionQueryAt("hey @pe x", 9)).toBeNull();
  });
});

describe("comment schemas and context", () => {
  it("requires a range to end after it starts and caps the body", () => {
    expect(CreateCommentSchema.safeParse({ body: "x", startSec: 5, endSec: 4 }).success).toBe(
      false,
    );
    expect(CreateCommentSchema.safeParse({ body: "x", endSec: 4 }).success).toBe(false);
    expect(CreateCommentSchema.safeParse({ body: "x", startSec: 1, endSec: 4 }).success).toBe(true);
    expect(CreateCommentSchema.safeParse({ body: "  " }).success).toBe(false);
    expect(CreateCommentSchema.safeParse({ body: "a".repeat(5001) }).success).toBe(false);
  });

  it("parses stored context leniently", () => {
    expect(parseCommentContext('{"trackVersions":{"t":"v"}}')).toEqual({
      trackVersions: { t: "v" },
      tempoRev: null,
    });
    expect(parseCommentContext("not json")).toEqual({ trackVersions: {}, tempoRev: null });
    expect(parseCommentContext('{"trackVersions":5}')).toEqual({
      trackVersions: {},
      tempoRev: null,
    });
  });

  it("makes plain excerpts", () => {
    expect(commentExcerpt("**Bass** is [late](http://x) `here`\n\nok")).toBe(
      "Bass is late here ok",
    );
    expect(commentExcerpt("a".repeat(200), 10)).toBe(`${"a".repeat(9)}…`);
  });
});

const base = {
  songId: "s",
  context: { trackVersions: {}, tempoRev: null },
  source: "app" as const,
  resolvedByName: null,
  editedAt: null,
  deleted: false,
  reactions: [],
  mentions: [],
  parentId: null,
};
const author = (name: string) => ({ userId: "u", name, username: "u", kind: "user" as const });

describe("export (SPEC §8: time, author, track, text, status)", () => {
  const comments: Comment[] = [
    {
      ...base,
      id: "a",
      trackId: "bass",
      author: author("Petr"),
      body: 'Bass is late, "really"',
      startSec: 65.25,
      endSec: 70,
      resolvedAt: null,
      createdAt: 1,
      replies: [
        {
          ...base,
          id: "b",
          parentId: "a",
          trackId: null,
          author: author("Vera"),
          body: "Agreed\nfix it",
          startSec: null,
          endSec: null,
          resolvedAt: null,
          createdAt: 2,
        },
      ],
    },
    {
      ...base,
      id: "c",
      trackId: null,
      author: author("Jan"),
      body: "",
      deleted: true,
      startSec: null,
      endSec: null,
      resolvedAt: 5,
      createdAt: 3,
      replies: [],
    },
  ];
  const rows = commentExportRows(comments, {
    trackName: (id) => (id === "bass" ? "Bass" : "?"),
    author: (a) => a.name,
    open: "open",
    resolved: "resolved",
    deleted: "(deleted)",
  });

  it("formats times", () => {
    expect(formatCommentTime(null, null)).toBe("");
    expect(formatCommentTime(5, null)).toBe("0:05.0");
    expect(formatCommentTime(3725.04, 3726)).toBe("1:02:05.0–1:02:06.0");
  });

  it("builds rows with replies after their comment", () => {
    expect(rows.map((r) => [r.time, r.author, r.track, r.status, r.reply])).toEqual([
      ["1:05.3–1:10.0", "Petr", "Bass", "open", false],
      ["1:05.3–1:10.0", "Vera", "Bass", "open", true],
      ["", "Jan", "", "resolved", false],
    ]);
    expect(rows[2]?.text).toBe("(deleted)");
  });

  it("writes RFC 4180 CSV", () => {
    const csv = commentsToCsv(rows, ["Time", "Author", "Track", "Text", "Status"]);
    expect(csv.split("\r\n")).toEqual([
      "Time,Author,Track,Text,Status",
      '1:05.3–1:10.0,Petr,Bass,"Bass is late, ""really""",open',
      '1:05.3–1:10.0,↳ Vera,Bass,"Agreed\nfix it",open',
      ",Jan,,(deleted),resolved",
      "",
    ]);
  });

  it("writes Markdown", () => {
    expect(commentsToMarkdown("Song", rows)).toBe(
      [
        "# Song",
        "",
        "- **1:05.3–1:10.0** Petr (Bass) · open",
        '  Bass is late, "really"',
        "  - Vera",
        "    Agreed",
        "    fix it",
        "- Jan · resolved",
        "  (deleted)",
        "",
      ].join("\n"),
    );
  });
});
