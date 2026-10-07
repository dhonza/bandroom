import { parseArgs } from "node:util";
import {
  ConfigError,
  createPasswordReset,
  findUserByLogin,
  hashPassword,
  insertUser,
  isUsernameTaken,
  loadConfig,
  openDb,
  pendingMigrationCount,
  runMigrations,
  type Db,
} from "@bandroom/server-core";
import { DisplayNameSchema, PasswordSchema, UsernameSchema } from "@bandroom/shared";
import { MIGRATIONS_DIR } from "./paths";
import { APP_VERSION } from "./version";

const USAGE = `Usage: bandroom <command> [options]

Commands:
  migrate                     Apply pending database migrations
  create-admin                Create an admin account (prompts for missing values)
      --username <name>  --display-name <name>  --password-stdin
  reset-link <username>       Print a one-time password reset link (valid 24 h)
  config check                Validate configuration from the environment
  version                     Print the version
  help                        Show this help`;

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  prompt: (question: string, hidden?: boolean) => Promise<string>;
  readStdin: () => Promise<string>;
}

class UsageError extends Error {}

function withDb<T>(env: Record<string, string | undefined>, fn: (db: Db, appUrl: string) => T): T {
  const config = loadConfig(env);
  const db = openDb(config.dbPath);
  try {
    runMigrations(db, MIGRATIONS_DIR);
    return fn(db, config.appUrl);
  } finally {
    db.$client.close();
  }
}

async function createAdmin(
  values: { username?: string; "display-name"?: string; "password-stdin"?: boolean },
  env: Record<string, string | undefined>,
  io: CliIo,
): Promise<number> {
  const username = UsernameSchema.safeParse(values.username ?? (await io.prompt("Username: ")));
  if (!username.success) throw new UsageError("Invalid username (3–32 chars: a–z, 0–9, . _ -)");
  const displayName = DisplayNameSchema.safeParse(
    values["display-name"] ??
      ((await io.prompt(`Display name [${username.data}]: `)) || username.data),
  );
  if (!displayName.success) throw new UsageError("Invalid display name");

  let password: string;
  if (values["password-stdin"]) {
    password = (await io.readStdin()).replace(/\r?\n$/, "");
  } else {
    password = await io.prompt("Password: ", true);
    if ((await io.prompt("Repeat password: ", true)) !== password) {
      throw new UsageError("Passwords do not match");
    }
  }
  if (!PasswordSchema.safeParse(password).success) {
    throw new UsageError("Password must be at least 10 characters");
  }
  const passwordHash = await hashPassword(password);

  return withDb(env, (db) => {
    if (isUsernameTaken(db, username.data))
      throw new UsageError(`User "${username.data}" already exists`);
    insertUser(db, {
      username: username.data,
      displayName: displayName.data,
      passwordHash,
      globalRole: "admin",
    });
    io.out(`Admin "${username.data}" created.`);
    return 0;
  });
}

/** Runs a CLI command and returns the process exit code. Exported for tests. */
export async function runCli(
  argv: string[],
  env: Record<string, string | undefined>,
  io: CliIo,
): Promise<number> {
  try {
    const { positionals, values } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        username: { type: "string" },
        "display-name": { type: "string" },
        "password-stdin": { type: "boolean" },
      },
    });
    const [command, sub] = positionals;

    switch (command) {
      case "version":
        io.out(APP_VERSION);
        return 0;
      case "migrate": {
        const config = loadConfig(env);
        const db = openDb(config.dbPath);
        const pending = pendingMigrationCount(db.$client, MIGRATIONS_DIR);
        runMigrations(db, MIGRATIONS_DIR);
        db.$client.close();
        io.out(`Applied ${pending} migration(s) to ${config.dbPath}`);
        return 0;
      }
      case "create-admin":
        return await createAdmin(values, env, io);
      case "reset-link": {
        if (!sub) throw new UsageError("Usage: bandroom reset-link <username>");
        return withDb(env, (db, appUrl) => {
          const user = findUserByLogin(db, sub);
          if (!user) throw new UsageError(`No user "${sub}"`);
          const { token } = createPasswordReset(db, user.id, null);
          io.out(`${appUrl.replace(/\/+$/, "")}/reset/${token}`);
          io.err("Valid for 24 hours, single use.");
          return 0;
        });
      }
      case "config": {
        if (sub !== "check") break;
        const config = loadConfig(env);
        for (const w of config.warnings) io.err(`warning: ${w}`);
        io.out(
          `Configuration OK (appUrl=${config.appUrl}, basePath=${config.basePath || "/"}, dataDir=${config.dataDir})`,
        );
        return 0;
      }
      case undefined:
      case "help":
        io.out(USAGE);
        return 0;
    }
  } catch (e) {
    if (e instanceof ConfigError) {
      io.err(e.message);
      return 2;
    }
    if (e instanceof UsageError || (e instanceof TypeError && "code" in e)) {
      io.err(e.message);
      return 1;
    }
    throw e;
  }
  io.err(USAGE);
  return 1;
}
