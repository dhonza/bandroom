import {
  createLogger,
  enqueueDocumentBackfill,
  enqueuePeaksBackfill,
  loadConfig,
  migrateDatabase,
  openDb,
} from "@bandroom/server-core";
import { buildApp } from "./app";
import { MIGRATIONS_DIR } from "./paths";
import { APP_VERSION } from "./version";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config, "server", "app");
  for (const w of config.warnings) logger.warn(w);

  const db = openDb(config.dbPath);
  // One-time data steps run before the migrations drop the old columns (SPEC §27.2, §28.4).
  const { conversion, purgedAutoMixes, droppedSongDocuments, songDocumentBytesFreed } =
    migrateDatabase(db, MIGRATIONS_DIR, Date.now(), config.purgeGcGraceMs);
  if (conversion) logger.info({ ...conversion, purgedAutoMixes }, "converted mix tracks (M21)");
  if (droppedSongDocuments !== null)
    logger.info(
      { documents: droppedSongDocuments, bytesFreed: songDocumentBytesFreed },
      "removed song documents (M22)",
    );
  logger.info({ dbPath: config.dbPath }, "database ready");
  const backfill = enqueueDocumentBackfill(db);
  if (backfill > 0) logger.info({ documents: backfill }, "queued document previews (backfill)");
  const peaks = enqueuePeaksBackfill(db);
  if (peaks > 0) logger.info({ assets: peaks }, "queued 16-bit waveform peaks (backfill)");

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
