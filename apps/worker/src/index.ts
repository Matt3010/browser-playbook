import { mkdir } from "fs/promises";
import { PrismaClient, NotificationService } from "@app/database";
import { createLogger } from "@app/shared";
import { loadConfig } from "./config";
import { SessionManager } from "./session/manager";
import { buildControlServer } from "./control-server";
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

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "Shutting down worker");
    try {
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
