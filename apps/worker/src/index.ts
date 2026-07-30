import { mkdir } from "fs/promises";
import { PrismaClient, NotificationService } from "@app/database";
import { createLogger } from "@app/shared";
import { loadConfig } from "./config";
import { SessionManager } from "./session/manager";
import { buildControlServer } from "./control-server";
import { pruneBrowserProfiles, pruneOldHistory } from "./retention";
import {
  startQueueConsumer,
  reconcileMissedSchedules,
  reconcileOrphanedExecutions
} from "./queue-consumer";

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger("worker");

  await mkdir(config.artifactDir, { recursive: true });
  await mkdir(config.uploadFixtureDir, { recursive: true });

  const prisma = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
  const notifications = new NotificationService(prisma);
  const sessions = new SessionManager(config, log);

  const consumer = startQueueConsumer({ config, prisma, notifications, sessions, log });
  const server = await buildControlServer(config, sessions, log);
  // Reclaims the slots of sessions whose page was closed or abandoned.
  sessions.startReaper();

  // Anything still in flight belonged to a process that no longer exists.
  await reconcileOrphanedExecutions({ prisma, notifications, log }).catch((err) =>
    log.error({ err }, "Could not reconcile orphaned executions")
  );
  await reconcileMissedSchedules({ prisma, notifications, log }).catch((err) =>
    log.error({ err }, "Could not reconcile missed schedules")
  );

  // Nothing has a natural end here: every run writes log lines, every failed run
  // writes a screenshot, and every workflow keeps a browser profile that grows
  // with its cache. Both are swept at startup and once a day after that.
  const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const prune = async () => {
    if (config.historyRetentionDays > 0) {
      await pruneOldHistory({
        prisma,
        log,
        artifactDir: config.artifactDir,
        retentionDays: config.historyRetentionDays
      }).catch((err) => log.error({ err }, "Could not prune old history"));
    }
    // Independent of the history setting: a profile whose workflow is gone holds
    // the cookies of a site the user is no longer automating, and goes either way.
    await pruneBrowserProfiles({
      prisma,
      log,
      profileDir: config.profileDir,
      retentionDays: config.profileRetentionDays
    }).catch((err) => log.error({ err }, "Could not prune browser profiles"));
  };
  if (config.historyRetentionDays === 0) {
    log.warn("History pruning is disabled (HISTORY_RETENTION_DAYS=0)");
  }
  await prune();
  const pruneTimer: NodeJS.Timeout | null = setInterval(() => void prune(), PRUNE_INTERVAL_MS);
  pruneTimer.unref();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "Shutting down worker");
    try {
      if (pruneTimer) clearInterval(pruneTimer);
      await server.close();
      await consumer.close();
      await sessions.closeAll();
      await prisma.$disconnect();
      process.exit(0);
    } catch (err) {
      log.error({ err }, "Error during worker shutdown");
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await server.listen({ port: config.port, host: config.host });
  log.info({ port: config.port }, "Worker started");
}

main().catch((err) => {
  console.error("Failed to start worker", err);
  process.exit(1);
});
