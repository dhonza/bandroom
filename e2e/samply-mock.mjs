// A tiny Samply API mock for e2e (SPEC §17: test without a live account). Same shapes as the
// live API (verified 2026-09-28). Started by start-stack.mjs when SAMPLY_MOCK_PORT is set.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

export const SAMPLY_MOCK_KEY = "e2e-samply-api-key";
const FIXTURES = path.resolve(import.meta.dirname, "../tools/fixtures/out");
const TONE = path.join(FIXTURES, "tone_48000_s16_stereo.wav");

const t0 = 1_760_000_000_000;
const box = (id, object, name, extra = {}) => ({
  id,
  object,
  name,
  color: "",
  timeCreated: t0,
  children: [],
  trashed: false,
  hidden: false,
  ...extra,
});
const BOXES = [
  box("stackdemo000001", "stack", "Demo Song", {
    children: [{ id: "filedemo0000001", name: "Demo Song.wav" }],
  }),
  box("filedemo0000001", "file", "Demo Song.wav", { duration: 10 }),
  box("folderstems0001", "folder", "Stems Tune", {
    children: [
      { id: "filebass0000001", name: "Stems Tune - Bass.wav" },
      { id: "filedrums000001", name: "Stems Tune - Drums.wav" },
    ],
  }),
  box("filebass0000001", "file", "Stems Tune - Bass.wav", { duration: 10 }),
  box("filedrums000001", "file", "Stems Tune - Drums.wav", { duration: 10 }),
  box("filelyrics00001", "file", "lyrics.txt"),
];
const PROJECTS = [
  {
    id: "projmock0000001",
    object: "project",
    name: "Mock Album",
    color: "#228be6",
    // Like most real projects: a picture exists but is not listed as a file (not importable).
    artwork: "https://cdn.samply.test/users/u1/files/aaaa-bbbb/cover.jpg",
    size: 5_800_000,
  },
];
const COMMENTS = {
  filedemo0000001: [
    {
      id: "commentmock0001",
      object: "comment",
      message: "Nice groove at the start",
      audioTimestamp: 1.2,
      completed: false,
      creator: { displayName: "Samply Friend", email: "friend@example.test" },
      timeCreated: t0 + 1000,
    },
  ],
};

export function startSamplyMock(port) {
  const origin = `http://127.0.0.1:${port}`;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", origin);
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname.startsWith("/files/")) {
      const id = url.pathname.slice("/files/".length);
      const isText = id === "filelyrics00001";
      const data = isText ? Buffer.from("Verse 1\nChorus\n") : fs.readFileSync(TONE);
      res.writeHead(200, {
        "content-type": isText ? "text/plain" : "audio/x-wav",
        "content-length": String(data.length),
      });
      res.end(req.method === "HEAD" ? undefined : data);
      return;
    }
    if (req.headers.authorization !== `Bearer ${SAMPLY_MOCK_KEY}`)
      return send(401, { error: "unauthorized" });
    const parts = url.pathname
      .replace(/^\/api\/v0\/?/, "")
      .split("/")
      .filter(Boolean);
    if (parts[0] !== "projects") return send(404, {});
    if (parts.length === 1) return send(200, PROJECTS);
    if (parts[1] !== PROJECTS[0].id) return send(404, {});
    if (parts[2] === "all") return send(200, BOXES);
    if (parts[2] === "insights") return send(200, []);
    if (parts[2] === "files" && parts[4] === "comments") return send(200, COMMENTS[parts[3]] ?? []);
    if (parts[2] === "files" && parts[4] === "download")
      return send(200, { url: `${origin}/files/${parts[3]}`, expires: Date.now() + 3_600_000 });
    return send(404, {});
  });
  server.listen(port, "127.0.0.1");
  return { url: `${origin}/api/v0`, close: () => server.close() };
}
