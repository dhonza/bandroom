import fs from "node:fs";
import path from "node:path";

export interface RemoteConfig {
  /** The instance URL including its base path, without a trailing slash. */
  url: string;
  apiKey: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * `KEY=value` lines of a dotenv-style file (comments, blank lines and optional quotes). Values are
 * taken literally: nothing is expanded or executed.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m?.[1]) continue;
    let value = (m[2] ?? "").trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

/**
 * `BANDROOM_URL` and `BANDROOM_API_KEY` from the environment, else from `.env.remote` in the repo
 * root (gitignored). The environment wins per variable.
 */
export function loadRemoteConfig(env: NodeJS.ProcessEnv, repoRoot: string): RemoteConfig {
  let file: Record<string, string> = {};
  const envFile = path.join(repoRoot, ".env.remote");
  if (fs.existsSync(envFile)) file = parseEnvFile(fs.readFileSync(envFile, "utf8"));
  const url = env.BANDROOM_URL ?? file.BANDROOM_URL;
  const apiKey = env.BANDROOM_API_KEY ?? file.BANDROOM_API_KEY;
  if (!url || !apiKey) {
    throw new ConfigError(
      "Set BANDROOM_URL and BANDROOM_API_KEY (environment or .env.remote in the repo root).",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError(`BANDROOM_URL is not a URL: ${url}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ConfigError("BANDROOM_URL must be http(s)");
  }
  if (
    parsed.protocol === "http:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
  ) {
    throw new ConfigError("BANDROOM_URL must use https (http only for localhost)");
  }
  return { url: `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`, apiKey };
}
