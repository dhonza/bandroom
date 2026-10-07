import type { Comment, CommentAuthor, CommentReply } from "./comments";

/** Comment export (SPEC §8: time, author, track, text, status). */

export interface CommentExportRow {
  time: string;
  author: string;
  track: string;
  text: string;
  status: string;
  /** Replies are listed after their comment. */
  reply: boolean;
}

/** Song time as m:ss.s (or h:mm:ss.s), for exports. */
export function formatCommentTime(start: number | null, end: number | null): string {
  if (start === null) return "";
  const f = (sec: number) => {
    const tenths = Math.round(sec * 10);
    const h = Math.floor(tenths / 36000);
    const m = Math.floor((tenths % 36000) / 600);
    const s = (tenths % 600) / 10;
    const ss = s.toFixed(1).padStart(4, "0");
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
  };
  return end === null ? f(start) : `${f(start)}–${f(end)}`;
}

export function commentExportRows(
  comments: readonly Comment[],
  labels: {
    trackName: (trackId: string) => string;
    author: (a: CommentAuthor) => string;
    open: string;
    resolved: string;
    deleted: string;
  },
): CommentExportRow[] {
  const rows: CommentExportRow[] = [];
  const row = (c: CommentReply, reply: boolean, parent: Comment): CommentExportRow => ({
    time: formatCommentTime(parent.startSec, parent.endSec),
    author: labels.author(c.author),
    track: parent.trackId ? labels.trackName(parent.trackId) : "",
    text: c.deleted ? labels.deleted : c.body,
    status: parent.resolvedAt !== null ? labels.resolved : labels.open,
    reply,
  });
  for (const c of comments) {
    rows.push(row(c, false, c));
    for (const r of c.replies) rows.push(row(r, true, c));
  }
  return rows;
}

const csvCell = (v: string) =>
  /[",\n\r]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

/** RFC 4180 CSV with a header row; replies get "↳ " before the author. */
export function commentsToCsv(
  rows: readonly CommentExportRow[],
  header: readonly string[],
): string {
  const lines = [header.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push(
      [r.time, `${r.reply ? "↳ " : ""}${r.author}`, r.track, r.text, r.status]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** Markdown: one list item per comment, replies nested below it. */
export function commentsToMarkdown(title: string, rows: readonly CommentExportRow[]): string {
  const out = [`# ${title}`, ""];
  for (const r of rows) {
    const indent = r.reply ? "  " : "";
    const head = r.reply
      ? r.author
      : [r.time && `**${r.time}**`, r.author, r.track && `(${r.track})`, `· ${r.status}`]
          .filter(Boolean)
          .join(" ");
    out.push(`${indent}- ${head}`);
    for (const line of r.text.split("\n")) out.push(`${indent}  ${line}`.trimEnd());
  }
  return `${out.join("\n")}\n`;
}
