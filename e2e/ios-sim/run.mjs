// Tier-2 device test (device test checklist): drives real Mobile Safari in the iOS Simulator via
// `safaridriver` (plain W3C WebDriver over fetch) against the built app on http://localhost.
//
//   pnpm build && node e2e/ios-sim/run.mjs [--subpath] [--device "iPhone 17"]
//
// Needs Xcode with an iOS simulator runtime and `safaridriver --enable` (run once by the owner).
// Writes screenshots and report.json to .cache/ios-sim/.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values: opts } = parseArgs({
  options: {
    subpath: { type: "boolean", default: false },
    device: { type: "string", default: "" },
    port: { type: "string", default: "3320" },
  },
});

const ROOT = process.cwd();
const OUT = path.join(ROOT, ".cache/ios-sim", opts.subpath ? "subpath" : "root");
const DATA = path.join(ROOT, ".data/ios-sim");
const PORT = Number(opts.port);
const WD_PORT = PORT + 1;
const BASE = `http://localhost:${PORT}${opts.subpath ? "/bandroom" : ""}/`;
const ADMIN = { username: "admin", password: "ios-sim-admin-password" };
const CSRF = { "X-Requested-With": "bandroom" };
const W3C_ELEMENT = "element-6066-11e4-a52e-4f735466cecf";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const children = [];

function log(msg) {
  console.log(`[ios-sim] ${msg}`);
}

function cleanup() {
  for (const c of children) c.kill("SIGTERM");
}
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

// --- Stack ------------------------------------------------------------------------------------

async function startStack() {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const env = {
    ...process.env,
    DATA_DIR: DATA,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    APP_URL: BASE.replace(/\/$/, ""),
    WEB_DIST_DIR: "apps/web/dist",
    LOG_LEVEL: "warn",
  };
  execFileSync(
    process.execPath,
    [
      "apps/server/dist/cli.js",
      "create-admin",
      "--username",
      ADMIN.username,
      "--display-name",
      "Sim Admin",
      "--password-stdin",
    ],
    { env, input: ADMIN.password, stdio: ["pipe", "ignore", "inherit"] },
  );
  const stack = spawn(process.execPath, ["e2e/start-stack.mjs"], { env, stdio: "inherit" });
  children.push(stack);
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}healthz`)).ok) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error("stack did not start");
}

// --- Seeding over the API (cookie jar by hand) ------------------------------------------------

let cookie = "";
async function apiCall(method, url, { json, headers = {}, body } = {}) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      ...CSRF,
      ...(cookie ? { cookie } : {}),
      ...(json ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: json ? JSON.stringify(json) : body,
  });
  const set = res.headers.getSetCookie();
  if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${await res.text()}`);
  return res;
}

function makeTone(file, seconds, freq) {
  execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${freq}:duration=${seconds}:sample_rate=48000`,
    "-af",
    "volume=0.3,apulsator=hz=0.5",
    "-ac",
    "2",
    "-c:a",
    "pcm_s16le",
    file,
  ]);
}

async function upload(songId, name, file) {
  const data = fs.readFileSync(file);
  const b64 = (s) => Buffer.from(s).toString("base64");
  const meta = `filename ${b64(`${name}.wav`)},target ${b64(
    JSON.stringify({ type: "newTrack", songId, name }),
  )}`;
  const created = await apiCall("POST", "api/v1/uploads", {
    headers: {
      "Tus-Resumable": "1.0.0",
      "Upload-Length": String(data.length),
      "Upload-Metadata": meta,
    },
  });
  const location = created.headers.get("location") ?? "";
  const rel = location.slice(location.indexOf("api/v1/uploads"));
  await apiCall("PATCH", rel, {
    headers: {
      "Tus-Resumable": "1.0.0",
      "Upload-Offset": "0",
      "Content-Type": "application/offset+octet-stream",
    },
    body: data,
  });
}

async function seed() {
  await apiCall("POST", "api/v1/auth/login", {
    json: { login: ADMIN.username, password: ADMIN.password },
  });
  const project = (
    await (
      await apiCall("POST", "api/v1/projects", { json: { name: "Sim Album", color: "teal" } })
    ).json()
  ).project;
  const songs = [];
  for (const title of ["Sim Song One", "Sim Song Two"]) {
    const song = (
      await (
        await apiCall("POST", `api/v1/projects/${project.id}/songs`, { json: { title } })
      ).json()
    ).song;
    songs.push(song);
  }
  const mix = path.join(OUT, "mix.wav");
  const bass = path.join(OUT, "bass.wav");
  makeTone(mix, 60, 330);
  makeTone(bass, 60, 110);
  for (const s of songs) await upload(s.id, "Keys", mix);
  await upload(songs[0].id, "Bass", bass);
  for (let i = 0; i < 240; i++) {
    const ready = await Promise.all(
      songs.map(async (s) => {
        const { tracks } = await (await apiCall("GET", `api/v1/songs/${s.id}/tracks`)).json();
        return tracks.every((t) => t.current?.status === "ready");
      }),
    );
    if (ready.every(Boolean)) return { project, songs };
    await sleep(500);
  }
  throw new Error("ingest did not finish");
}

// --- WebDriver --------------------------------------------------------------------------------

let session = "";
async function wd(method, url, body, timeoutMs = 60_000) {
  const res = await fetch(
    `http://127.0.0.1:${WD_PORT}${session ? `/session/${session}` : ""}${url}`,
    {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  const json = await res.json();
  if (!res.ok) throw new Error(`WebDriver ${method} ${url}: ${JSON.stringify(json.value)}`);
  return json.value;
}

async function startSafari() {
  const driver = spawn("safaridriver", ["-p", String(WD_PORT)], { stdio: "inherit" });
  children.push(driver);
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`http://127.0.0.1:${WD_PORT}/status`);
      break;
    } catch {
      await sleep(250);
    }
  }
  const caps = {
    browserName: "Safari",
    platformName: "iOS",
    "safari:useSimulator": true,
    ...(opts.device ? { "safari:deviceName": opts.device } : { "safari:deviceType": "iPhone" }),
  };
  const value = await wd("POST", "/session", { capabilities: { alwaysMatch: caps } }, 600_000);
  session = value.sessionId;
  log(
    `session ${session} (${value.capabilities?.["safari:deviceName"] ?? "?"}, iOS ${value.capabilities?.platformVersion ?? "?"})`,
  );
  return value.capabilities;
}

const js = (script, ...args) => wd("POST", "/execute/sync", { script, args });
const jsAsync = (script, ...args) => wd("POST", "/execute/async", { script, args });

async function find(css) {
  const v = await wd("POST", "/element", { using: "css selector", value: css });
  return v[W3C_ELEMENT];
}

async function waitFor(desc, script, timeoutMs = 20_000, ...args) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await js(script, ...args);
      if (last) return last;
    } catch (err) {
      last = String(err);
    }
    await sleep(300);
  }
  throw new Error(`timed out waiting for ${desc} (last: ${JSON.stringify(last)})`);
}

// Native WebDriver clicks on iOS Simulator can return without delivering any DOM event, and the
// Actions API can hang. Try the native click; if the page saw no tap, fall back to a JS click.
const inputPaths = [];
async function click(css) {
  const before = await js(`return (window.__taps ?? []).length;`);
  await wd("POST", `/element/${await find(css)}/click`, {}, 15_000).catch(() => undefined);
  await sleep(500);
  const after = await js(`return (window.__taps ?? []).length;`);
  if (after > before) {
    inputPaths.push({ css, path: "native" });
    return;
  }
  await js(`document.querySelector(arguments[0]).click();`, css);
  inputPaths.push({ css, path: "js" });
}

/** Seek via the overview strip at a fraction of its width (no pointer capture involved). */
async function seekOverview(fx) {
  await js(
    `const c = document.querySelector('[data-testid="timeline"] canvas[role="slider"]');
     const r = c.getBoundingClientRect();
     c.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: r.left + r.width * arguments[0], clientY: r.top + r.height / 2, pointerId: 1, isPrimary: true, buttons: 1 }));`,
    fx,
  );
}

/** Records taps and play() outcomes; re-run after each full page load. */
const instrument = `if (!window.__plays) {
  window.__plays = [];
  window.__taps = [];
  for (const type of ["pointerup", "touchend", "click"])
    document.addEventListener(type, (e) => window.__taps.push(type + ":" + (e.target.closest("[data-testid]")?.dataset.testid ?? e.target.tagName)), true);
  const orig = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    const p = orig.call(this);
    p.then(() => window.__plays.push("ok"), (e) => window.__plays.push(e.name + ": " + e.message));
    return p;
  };
}`;

async function screenshot(name) {
  const b64 = await wd("GET", "/screenshot");
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(b64, "base64"));
}

/** A check the tooling could not decide (e.g. only a non-gesture JS click was possible). */
class Inconclusive extends Error {}

async function step(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? null });
    log(`✓ ${name}${detail ? ` — ${JSON.stringify(detail)}` : ""}`);
  } catch (err) {
    if (err instanceof Inconclusive) {
      results.push({ name, ok: null, note: err.message });
      log(`? ${name} — inconclusive: ${err.message}`);
      return Date.now() - t0;
    }
    results.push({ name, ok: false, error: String(err instanceof Error ? err.message : err) });
    log(`✗ ${name} — ${err instanceof Error ? err.message : err}`);
    await screenshot(`fail-${results.length}`).catch(() => undefined);
  }
  return Date.now() - t0;
}

// The Player is the engine (SPEC §27.4): its debug state gives the position (48 kHz frames).
const position = `
  const s = window.__bandroomRehearse?.state();
  return s ? s.position / 48000 : -1;`;
const playing = `return !!document.querySelector('[data-testid="rehearse-play"][aria-label="Pause"]');`;

// --- Scenario ---------------------------------------------------------------------------------

async function run() {
  await startStack();
  log("stack up; seeding");
  const { project, songs } = await seed();
  const caps = await startSafari();
  results.push({
    name: "device",
    ok: true,
    detail: {
      device: caps?.["safari:deviceName"],
      ios: caps?.platformVersion,
      safari: caps?.browserVersion,
    },
  });

  await step("login page renders", async () => {
    await wd("POST", "/url", { url: `${BASE}login` });
    await waitFor("login form", `return !!document.querySelector('input[type="password"]');`);
    await screenshot("01-login");
  });

  await step("log in", async () => {
    const r = await jsAsync(
      `const done = arguments[arguments.length - 1];
       fetch("api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json", "X-Requested-With": "bandroom" },
         body: JSON.stringify({ login: arguments[0], password: arguments[1] }) }).then(r => done(r.status), e => done(String(e)));`,
      ADMIN.username,
      ADMIN.password,
    );
    if (r !== 200) throw new Error(`login status ${r}`);
  });

  await step("browser capabilities", async () => {
    await wd("POST", "/url", { url: `${BASE}songs/${songs[0].id}` });
    await waitFor(
      "player",
      `return !!document.querySelector('[data-testid="rehearse-play"]:not([disabled])');`,
      30_000,
    );
    const c = await js(`
      const a = document.createElement("audio");
      return {
        secureContext: window.isSecureContext,
        audioWorklet: typeof AudioWorkletNode !== "undefined",
        webAssembly: typeof WebAssembly !== "undefined",
        mediaSession: "mediaSession" in navigator,
        oggOpus: a.canPlayType('audio/ogg; codecs="opus"'),
        webmOpus: a.canPlayType('audio/webm; codecs="opus"'),
        viewport: [window.innerWidth, window.innerHeight],
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
        userAgent: navigator.userAgent,
      };`);
    await screenshot("02-song");
    if (c.horizontalOverflow) throw new Error(`horizontal overflow ${JSON.stringify(c)}`);
    return c;
  });

  await step("play starts from a tap", async () => {
    await js(instrument);
    await click('[data-testid="rehearse-play"]');
    try {
      await waitFor("playing", playing, 20_000);
    } catch (err) {
      const d = await js(`return { plays: window.__plays, taps: window.__taps };`);
      d.input = inputPaths.at(-1)?.path;
      if (
        d.input === "js" &&
        d.plays?.length &&
        d.plays.every((x) => x.startsWith("NotAllowedError"))
      )
        throw new Inconclusive(
          `play() was called inside the tap handler, but only a JS click was possible and iOS requires a real gesture ${JSON.stringify(d)}`,
        );
      throw new Error(`${err instanceof Error ? err.message : err}; ${JSON.stringify(d)}`, {
        cause: err,
      });
    }
    const p0 = await js(position);
    await sleep(2500);
    const p1 = await js(position);
    if (!(p1 > p0)) throw new Error(`position not advancing: ${p0} → ${p1}`);
    await screenshot("03-playing");
    return {
      from: p0,
      to: p1,
      input: inputPaths.at(-1)?.path,
      plays: await js(`return window.__plays;`),
    };
  });

  await step("media session metadata", async () => {
    const m = await js(`const m = navigator.mediaSession?.metadata;
      return m ? { title: m.title, artist: m.artist, state: navigator.mediaSession.playbackState } : null;`);
    if (m?.title !== "Sim Song One") throw new Error(`metadata ${JSON.stringify(m)}`);
    return m;
  });

  await step("timeline tap seeks", async () => {
    await seekOverview(0.75);
    const p = await waitFor(
      "seek",
      `const p = (() => {${position}})(); return p > 30 ? p : 0;`,
      10_000,
    );
    return { position: p };
  });

  await step("quality switch keeps playing", async () => {
    const before = await js(position);
    await click('[data-testid="rehearse-transport"] button[aria-label="Playback options"]');
    await waitFor("menu", `return [...document.querySelectorAll('[role="menuitem"]')].length > 0;`);
    await js(
      `[...document.querySelectorAll('[role="menuitem"]')].find(e => /^Low/.test(e.textContent.trim())).click();`,
    );
    await waitFor("low quality", `return window.__bandroomRehearse?.state().quality === "low";`);
    await waitFor("still playing", playing, 15_000);
    await sleep(1500);
    const after = await js(position);
    if (!(after >= before - 1)) throw new Error(`position jumped back: ${before} → ${after}`);
    return { before, after };
  });

  await step("mini-player survives in-app navigation", async () => {
    await click('[data-testid="bottom-tab-bar"] a[href$="library"]');
    await waitFor("mini-player", `return !!document.querySelector('[data-testid="mini-player"]');`);
    const t0 = await js(
      `return document.querySelector('[data-testid="mini-player"] [role="progressbar"]')?.getAttribute("aria-valuenow") ?? null;`,
    );
    await sleep(2000);
    const playingMini = await js(
      `return document.querySelector('[data-testid="mini-play"]')?.getAttribute("aria-label");`,
    );
    await screenshot("04-mini-player");
    if (playingMini !== "Pause") throw new Error(`mini-player shows ${playingMini}`);
    return { progress: t0 };
  });

  // The engine queue (SPEC §6.10): "Play all" on the project page, then the next song.
  await step("Play all from the project page", async () => {
    await click(`a[href$="projects/${project.id}"]`);
    await waitFor(
      "play all",
      `return !!document.querySelector('[data-testid="play-all"]:not([data-loading])');`,
    );
    await click('[data-testid="play-all"]');
    await waitFor(
      "song one",
      `return /Sim Song One/.test(document.querySelector('[data-testid="mini-title"]')?.textContent ?? "");`,
    );
    await waitFor(
      "playing",
      `return document.querySelector('[data-testid="mini-play"]')?.getAttribute("aria-label") === "Pause";`,
      15_000,
    );
    return await js(`return navigator.mediaSession?.metadata?.title ?? null;`);
  });

  await step("next song from the mini-player", async () => {
    await click('[data-testid="mini-next"]');
    await waitFor(
      "song two",
      `return /Sim Song Two/.test(document.querySelector('[data-testid="mini-title"]')?.textContent ?? "");`,
    );
    await waitFor(
      "playing",
      `return document.querySelector('[data-testid="mini-play"]')?.getAttribute("aria-label") === "Pause";`,
      15_000,
    );
    return await js(`return navigator.mediaSession?.metadata?.title ?? null;`);
  });

  await step("pause from the mini-player", async () => {
    await click('[data-testid="mini-play"]');
    await waitFor(
      "paused",
      `return document.querySelector('[data-testid="mini-play"]')?.getAttribute("aria-label") === "Play";`,
    );
    await screenshot("05-paused");
  });
}

let exitCode = 0;
try {
  await run();
} catch (err) {
  exitCode = 1;
  log(`aborted: ${err instanceof Error ? err.stack : err}`);
  results.push({ name: "run", ok: false, error: String(err) });
} finally {
  if (session) await wd("DELETE", "").catch(() => undefined);
  cleanup();
}
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify({ results, inputPaths }, null, 2));
const failed = results.filter((r) => r.ok === false);
const unsure = results.filter((r) => r.ok === null);
log(
  `${results.length - failed.length - unsure.length}/${results.length} ok, ${unsure.length} inconclusive; report in ${path.relative(ROOT, OUT)}`,
);
process.exit(failed.length || exitCode ? 1 : 0);
