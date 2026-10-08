import path from "node:path";
import { parseArgs } from "node:util";
import { Client, RemoteError } from "./client";
import { ConfigError, loadRemoteConfig } from "./config";
import { run, USAGE, UsageError } from "./commands";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== "--"),
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      wait: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      status: { type: "string" },
      type: { type: "string" },
      since: { type: "string" },
      action: { type: "string" },
      user: { type: "string" },
      project: { type: "string" },
      source: { type: "string" },
      level: { type: "string" },
      hours: { type: "string" },
      limit: { type: "string" },
      song: { type: "string" },
      track: { type: "string" },
      name: { type: "string" },
      confirm: { type: "string" },
    },
  });
  const out = (s: string) => {
    process.stdout.write(`${s}\n`);
  };
  if (values.help || positionals.length === 0 || positionals[0] === "help") {
    out(USAGE);
    return 0;
  }
  const config = loadRemoteConfig(process.env, REPO_ROOT);
  const client = new Client(config);
  // pnpm runs scripts in the package directory; INIT_CWD is where the command was typed.
  await run(client, positionals, { ...values, cwd: process.env.INIT_CWD ?? process.cwd() }, out);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    if (err instanceof RemoteError) {
      process.stderr.write(`error ${err.status} ${err.code}: ${err.message}\n`);
    } else if (err instanceof UsageError || err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n\n${err instanceof UsageError ? USAGE : ""}\n`);
    } else if (
      err instanceof Error &&
      err.name === "TypeError" &&
      /fetch failed/.test(err.message)
    ) {
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      process.stderr.write(
        `cannot reach the server: ${cause?.code ?? cause?.message ?? err.message}\n`,
      );
    } else {
      process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    }
    process.exitCode = 1;
  },
);
