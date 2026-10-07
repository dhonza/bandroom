import {
  createLogger,
  enqueueDocumentBackfill,
  loadConfig,
  migrateDatabase,
  openDb,
} from "@bandroom/server-core";
import { buildApp } from "./app";
import { MIGRATIONS_DIR } from "./paths";
import { APP_VERSION } from "./version";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config, "server");
  for (const w of config.warnings) logger.warn(w);

  const db = openDb(config.dbPath);
  // M21: the mix-track conversion runs before the migrations drop the old columns (SPEC §27.2).
  const { conversion, purgedAutoMixes } = migrateDatabase(db, MIGRATIONS_DIR);
  if (conversion) logger.info({ ...conversion, purgedAutoMixes }, "converted mix tracks (M21)");
  logger.info({ dbPath: config.dbPath }, "database ready");
  const backfill = enqueueDocumentBackfill(db);
  if (backfill > 0) logger.info({ documents: backfill }, "queued document previews (backfill)");

  const app = await buildApp({ config, db, logger, runJobs: true });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    await app.close();
    db.$client.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ host: config.host, port: config.port });
  logger.info(
    { version: APP_VERSION, basePath: config.basePath || "/", appUrl: config.appUrl },
    "server listening",
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
