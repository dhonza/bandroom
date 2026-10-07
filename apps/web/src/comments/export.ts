import {
  commentExportRows,
  commentsToCsv,
  commentsToMarkdown,
  type Comment,
  type Track,
} from "@bandroom/shared";
import { sortComments } from "./model";

/** Byte order mark so spreadsheet apps read the CSV as UTF-8. */
const BOM = String.fromCharCode(0xfeff);

/** Translated texts of a comment export. */
export interface CommentExportLabels {
  /** Suffix of imported authors ("(Samply)"). */
  imported: string;
  deletedUser: string;
  open: string;
  resolved: string;
  deleted: string;
  /** CSV column headers: time, author, track, text, status. */
  header: string[];
}

/** A song's comments as a Markdown or CSV file named after `base` (SPEC §8 export). */
export function buildCommentExport(
  format: "md" | "csv",
  base: string,
  comments: readonly Comment[],
  tracks: readonly Track[],
  labels: CommentExportLabels,
): { name: string; type: string; text: string } {
  const rows = commentExportRows(sortComments(comments, "time"), {
    trackName: (id) => tracks.find((x) => x.id === id)?.name ?? "",
    author: (a) =>
      a.kind === "imported" ? `${a.name} ${labels.imported}` : a.name || labels.deletedUser,
    open: labels.open,
    resolved: labels.resolved,
    deleted: labels.deleted,
  });
  if (format === "csv") {
    return {
      name: `${base}.csv`,
      type: "text/csv;charset=utf-8",
      text: `${BOM}${commentsToCsv(rows, labels.header)}`,
    };
  }
  return {
    name: `${base}.md`,
    type: "text/markdown;charset=utf-8",
    text: commentsToMarkdown(base, rows),
  };
}

/** Saves `text` as a file through a temporary link. */
export function download(name: string, type: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}
