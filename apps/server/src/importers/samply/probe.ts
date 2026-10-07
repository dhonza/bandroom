/**
 * Read-only probe of the live Samply API (SPEC §17, open question 1): verifies endpoints, auth,
 * pagination and rate-limit headers against the owner's account before the connector is built.
 *
 *   pnpm --filter server samply:probe [--projects 2] [--files 3]
 *
 * GET requests only. Raw responses go to .cache/samply-probe/ (gitignored, local only); the console
 * shows value *shapes* (types, key sets, array lengths), never contents.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const BASE = "https://samply.app/api/v0";
const OUT = path.resolve(import.meta.dirname, "../../../../../.cache/samply-probe");

const { values } = parseArgs({
  options: {
    projects: { type: "string", default: "2" },
    files: { type: "string", default: "3" },
    /** Count comments on every file of every project (shapes only). */
    sweep: { type: "boolean", default: false },
  },
});
const maxProjects = Number(values.projects);
const maxFiles = Number(values.files);

const key = process.env.SAMPLY_API_KEY;
if (!key) {
  console.error("SAMPLY_API_KEY is not set (put it in ./.env)");
  process.exit(1);
}

const sleep = (ms: number) =>
  new Promise((r) => {
    setTimeout(r, ms);
  });
const headersSeen = new Map<string, string>();
let calls = 0;

/** Types only: `{a: string, b: [n× {…}]}`; arrays show their length and the merged item shape. */
function shape(v: unknown, depth = 0): string {
  if (v === null) return "null";
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    const items = [...new Set(v.slice(0, 20).map((x) => shape(x, depth + 1)))];
    return `[${v.length}× ${items.join(" | ")}]`;
  }
  if (typeof v === "object") {
    if (depth > 4) return "{…}";
    const entries = Object.entries(v as Record<string, unknown>).map(
      ([k, x]) => `${k}: ${shape(x, depth + 1)}`,
    );
    return `{${entries.join(", ")}}`;
  }
  return typeof v;
}

async function get(url: string, save: string): Promise<unknown> {
  await sleep(400); // gentle: rate limits are undocumented
  calls++;
  const res = await fetch(`${BASE}${url}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  for (const [k, v] of res.headers) {
    if (/rate|limit|retry|link|cursor|page|total|next/i.test(k)) headersSeen.set(k, v);
  }
  const text = await res.text();
  fs.writeFileSync(path.join(OUT, `${save}.json`), text);
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep text
  }
  // Route template only (ids replaced), so the log carries no identifiers.
  const route = url.replace(/\/[A-Za-z0-9_-]{12,}/g, "/:id");
  console.log(`\nGET ${route} → ${res.status} ${res.headers.get("content-type") ?? ""}`);
  console.log(`  ${shape(body)}`);
  return res.ok ? body : null;
}

const asArray = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v)
    ? (v as Record<string, unknown>[])
    : v && typeof v === "object" && Array.isArray((v as { data?: unknown }).data)
      ? (v as { data: Record<string, unknown>[] }).data
      : [];

fs.mkdirSync(OUT, { recursive: true });
const projects = asArray(await get("/projects", "projects"));
console.log(
  `\n${projects.length} owned project(s); probing ${Math.min(maxProjects, projects.length)}`,
);

for (const [pi, p] of projects.slice(0, maxProjects).entries()) {
  const id = String(p.id);
  await get(`/projects/${id}`, `p${pi}-project`);
  const all = asArray(await get(`/projects/${id}/all`, `p${pi}-all`));
  await get(`/projects/${id}/folders`, `p${pi}-folders`);
  await get(`/projects/${id}/insights?limit=5`, `p${pi}-insights`);
  const kinds = new Map<string, number>();
  for (const b of all) kinds.set(String(b.object), (kinds.get(String(b.object)) ?? 0) + 1);
  console.log(`  boxes by kind: ${JSON.stringify(Object.fromEntries(kinds))}`);

  const files = all.filter((b) => b.object === "file").slice(0, maxFiles);
  for (const [fi, f] of files.entries()) {
    const fid = String(f.id);
    await get(`/projects/${id}/files/${fid}`, `p${pi}-f${fi}-file`);
    await get(`/projects/${id}/files/${fid}/comments`, `p${pi}-f${fi}-comments`);
    // Returns a signed URL only; the file itself is not fetched.
    await get(`/projects/${id}/files/${fid}/download`, `p${pi}-f${fi}-download`);
  }
  const stack = all.find((b) => b.object === "stack");
  if (stack) await get(`/projects/${id}/files/${String(stack.id)}`, `p${pi}-stack`);
}
await get("/players", "players");

// One signed download URL: HEAD only (size/type), the file itself is not fetched.
const firstProject = projects[0];
if (firstProject) {
  const all = asArray(await get(`/projects/${String(firstProject.id)}/all`, "head-all"));
  const file = all.find((b) => b.object === "file" && typeof b.duration === "number");
  if (file) {
    const dl = (await get(
      `/projects/${String(firstProject.id)}/files/${String(file.id)}/download`,
      "head-download",
    )) as { url?: string; expires?: number } | null;
    if (dl?.url) {
      const head = await fetch(dl.url, { method: "HEAD" });
      console.log(`\nHEAD <signed url> → ${head.status}`);
      for (const k of ["content-type", "content-length", "content-disposition", "accept-ranges"])
        console.log(
          `  ${k}: ${k === "content-disposition" ? (head.headers.get(k) ? "(present)" : "null") : head.headers.get(k)}`,
        );
      console.log(`  expires in ${Math.round(((dl.expires ?? 0) - Date.now()) / 60000)} min`);
    }
  }
}

if (values.sweep) {
  let files = 0;
  let withComments = 0;
  let total = 0;
  const shapes = new Set<string>();
  for (const [pi, p] of projects.entries()) {
    const all = asArray(await get(`/projects/${String(p.id)}/all`, `sweep-p${pi}-all`));
    for (const f of all.filter((b) => b.object === "file")) {
      files++;
      const c = asArray(
        await get(
          `/projects/${String(p.id)}/files/${String(f.id)}/comments`,
          `sweep-p${pi}-${String(f.id)}-comments`,
        ),
      );
      if (c.length) {
        withComments++;
        total += c.length;
        for (const x of c) shapes.add(shape(x));
      }
    }
  }
  console.log(
    `\nSweep: ${files} files, ${withComments} with comments, ${total} comments. Comment shapes:`,
  );
  for (const sh of shapes) console.log(`  ${sh}`);
}

console.log(`\n${calls} calls. Pagination/rate-limit related headers seen:`);
for (const [k, v] of headersSeen) console.log(`  ${k}: ${v}`);
console.log(`Raw responses (local only): ${path.relative(process.cwd(), OUT)}`);
