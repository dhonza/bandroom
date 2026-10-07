import fs from "node:fs";
import path from "node:path";
import { TEST_MIGRATIONS_DIR } from "./testDb";

interface Journal {
  entries: { idx: number; tag: string }[];
}

const readJournal = (): Journal =>
  JSON.parse(
    fs.readFileSync(path.join(TEST_MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
  ) as Journal;

/** A copy of the migrations folder in `dir` holding migrations 0…`lastIdx` (old-schema fixtures). */
export function migrationsUpTo(dir: string, lastIdx: number): string {
  const out = path.join(dir, `migrations-${lastIdx}`);
  fs.mkdirSync(path.join(out, "meta"), { recursive: true });
  const journal = readJournal();
  journal.entries = journal.entries.filter((e) => e.idx <= lastIdx);
  for (const e of journal.entries)
    fs.copyFileSync(path.join(TEST_MIGRATIONS_DIR, `${e.tag}.sql`), path.join(out, `${e.tag}.sql`));
  fs.writeFileSync(path.join(out, "meta", "_journal.json"), JSON.stringify(journal));
  return out;
}

/** The index of the migration whose tag ends with `suffix` (e.g. `drop_song_documents`). */
export function migrationIndex(suffix: string): number {
  const e = readJournal().entries.find((x) => x.tag.endsWith(suffix));
  if (!e) throw new Error(`no migration *${suffix}`);
  return e.idx;
}
