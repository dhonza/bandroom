import type { Comment, Track } from "@bandroom/shared";
import { describe, expect, it } from "vitest";
import { buildCommentExport, type CommentExportLabels } from "./export";

const comment = (id: string, over: Partial<Comment> = {}): Comment => ({
  id,
  songId: "s",
  trackId: null,
  parentId: null,
  author: { userId: "u1", name: "Petr", username: "petr", kind: "user" },
  body: `text ${id}`,
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
  replies: [],
  ...over,
});

const labels: CommentExportLabels = {
  imported: "(Samply)",
  deletedUser: "Deleted user",
  open: "Open",
  resolved: "Resolved",
  deleted: "Deleted",
  header: ["Time", "Author", "Track", "Text", "Status"],
};

const tracks = [{ id: "bass", name: "Bass" }] as Track[];

const comments = [
  comment("late", { startSec: 30, trackId: "bass" }),
  comment("early", {
    startSec: 5,
    author: { userId: null, name: "Old Friend", username: null, kind: "imported" },
  }),
  comment("gone", {
    startSec: 10,
    author: { userId: null, name: "", username: null, kind: "user" },
  }),
];

describe("buildCommentExport", () => {
  it("writes a UTF-8 CSV with a BOM and translated headers, sorted by time", () => {
    const file = buildCommentExport("csv", "Song – Comments", comments, tracks, labels);
    expect(file.name).toBe("Song – Comments.csv");
    expect(file.type).toBe("text/csv;charset=utf-8");
    expect(file.text.startsWith("﻿Time,Author,Track,Text,Status")).toBe(true);
    const order = ["early", "gone", "late"].map((id) => file.text.indexOf(`text ${id}`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(file.text).toContain("Old Friend (Samply)");
    expect(file.text).toContain("Deleted user");
    expect(file.text).toContain("Bass");
  });

  it("writes Markdown titled after the song", () => {
    const file = buildCommentExport("md", "Song – Comments", comments, tracks, labels);
    expect(file.name).toBe("Song – Comments.md");
    expect(file.type).toBe("text/markdown;charset=utf-8");
    expect(file.text).toContain("Song – Comments");
    expect(file.text).not.toContain("﻿");
  });
});
