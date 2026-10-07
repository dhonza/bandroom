/**
 * Turns raw Samply probe responses (.cache/samply-probe, local only) into committed test fixtures
 * (SPEC §17: "recorded fixtures (sanitized JSON responses)"). Keeps structure, durations, sizes,
 * colors and timestamps; replaces every id, name, person and URL. Fails if any original string
 * other than known enum values survives.
 *
 *   pnpm --filter server exec tsx src/importers/samply/fixtures/sanitize.ts
 */
import fs from "node:fs";
import path from "node:path";

const RAW = path.resolve(import.meta.dirname, "../../../../../../.cache/samply-probe");
const OUT = import.meta.dirname;
const KEEP_STRINGS = new Set([
  "project",
  "file",
  "folder",
  "stack",
  "custom",
  "name",
  "timeCreated",
]);
const HEX = /^#?[0-9a-f]{3,8}$/i;

const read = (f: string): unknown => JSON.parse(fs.readFileSync(path.join(RAW, f), "utf8"));
type Json = Record<string, unknown>;

const ids = new Map<string, string>();
const fakeId = (real: string, prefix: string) => {
  let v = ids.get(real);
  if (!v) {
    v = `${prefix}${String(ids.size + 1).padStart(4, "0")}fixture`;
    ids.set(real, v);
  }
  return v;
};
const ext = (name: string) => /\.[A-Za-z0-9]{1,5}$/.exec(name)?.[0] ?? "";

function project(p: Json, i: number): Json {
  return {
    id: fakeId(String(p.id), "proj"),
    object: "project",
    name: `Project ${String.fromCharCode(65 + i)}`,
    creator: {
      uid: "user0001fixture",
      displayName: "Owner",
      email: "owner@example.test",
      photoURL: "",
    },
    size: p.size,
    color: p.color,
    artwork: p.artwork ? "https://example.test/artwork.jpg" : "",
    timeCreated: p.timeCreated,
    timeModified: p.timeModified,
    sortBy: p.sortBy,
  };
}

function boxes(all: Json[]): Json[] {
  let n = 0;
  const names = new Map<string, string>();
  for (const b of all) {
    n++;
    const kind = String(b.object);
    names.set(
      String(b.id),
      kind === "folder"
        ? `Folder ${n}`
        : kind === "stack"
          ? `Song ${n}`
          : `Take ${n}${ext(String(b.name))}`,
    );
  }
  return all.map((b) => ({
    ...b,
    id: fakeId(String(b.id), "box"),
    name: names.get(String(b.id)),
    children: ((b.children as Json[] | undefined) ?? []).map((c) => ({
      id: fakeId(String(c.id), "box"),
      name: names.get(String(c.id)) ?? "Unknown",
    })),
  }));
}

const projects = (read("projects.json") as Json[]).map(project);
const out: Record<string, unknown> = { "projects.json": projects };
for (const pi of [0, 1]) {
  const raw = read(`p${pi}-all.json`) as Json[];
  out[`project-${pi}-all.json`] = boxes(raw);
}

// Leak check: no original string (ids, names, emails, URLs) may survive.
const originals = new Set<string>();
const collect = (v: unknown) => {
  if (typeof v === "string") {
    if (v.length >= 4 && !KEEP_STRINGS.has(v) && !HEX.test(v)) originals.add(v);
  } else if (Array.isArray(v)) v.forEach(collect);
  else if (v && typeof v === "object") Object.values(v).forEach(collect);
};
collect(read("projects.json"));
for (const pi of [0, 1]) collect(read(`p${pi}-all.json`));
for (const [file, data] of Object.entries(out)) {
  const text = JSON.stringify(data);
  const leaks = [...originals].filter((s) => text.includes(s));
  if (leaks.length) throw new Error(`${file}: ${leaks.length} original strings survived`);
  fs.writeFileSync(path.join(OUT, file), `${JSON.stringify(data, null, 2)}\n`);
}
console.log(
  `wrote ${Object.keys(out).length} fixtures; ${originals.size} original strings checked`,
);
