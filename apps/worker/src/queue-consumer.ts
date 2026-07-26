import { Worker, type Job } from "bullmq";
import IORedis, { type Redis } from "ioredis";
import type { PrismaClient, NotificationService } from "@app/database";
import type { Logger } from "@app/shared";
import type { WorkerConfig } from "./config";
import type { SessionManager } from "./session/manager";
import { runExecution } from "./runner/run-execution";

export const EXECUTION_QUEUE_NAME = "workflow-executions";

export interface ExecutionJobData {
  executionId: string;
  workflowId: string;
  userId: string;
  scheduleId?: string | null;
}

export interface QueueConsumerDeps {
  config: WorkerConfig;
  prisma: PrismaClient;
  notifications: NotificationService;
  sessions: SessionManager;
  log: Logger;
}

export interface QueueConsumer {
  worker: Worker<ExecutionJobData>;
  close: () => Promise<void>;
}

export function startQueueConsumer(deps: QueueConsumerDeps): QueueConsumer {
  const connection: Redis = new IORedis(deps.config.redisUrl, { maxRetriesPerRequest: null });

  const worker = new Worker<ExecutionJobData>(
    EXECUTION_QUEUE_NAME,
    async (job: Job<ExecutionJobData>) => {
      deps.log.info({ jobId: job.id, data: job.data }, "Picked up execution job");
      const result = await runExecution(job.data, {
        prisma: deps.prisma,
        notifications: deps.notifications,
        sessions: deps.sessions,
        config: deps.config,
        log: deps.log
      });
      // A failed workflow is a normal, fully-recorded outcome: the job itself
      // succeeded, which keeps BullMQ from retrying (the MVP never retries).
      return result;
    },
    {
      connection,
      // One execution at a time per worker keeps the browser session count and
      // the display/port allocation predictable.
      concurrency: 1
    }
  );

  worker.on("failed", (job, err) => {
    deps.log.error({ jobId: job?.id, err }, "Execution job threw");
  });
  worker.on("completed", (job) => {
    deps.log.info({ jobId: job.id }, "Execution job finished");
  });

  return {
    worker,
    close: async () => {
      await worker.close();
      connection.disconnect();
    }
  };
}

/**
 * Marks schedules whose start time has passed but whose queue job is gone as
 * failed, and notifies the owner. This runs at startup so a job lost while the
 * stack was down does not leave a schedule pending forever.
 */
export async function reconcileMissedSchedules(deps: {
  prisma: PrismaClient;
  notifications: NotificationService;
  log: Logger;
  graceMs?: number;
}): Promise<number> {
  const graceMs = deps.graceMs ?? 60_000;
  const cutoff = new Date(Date.now() - graceMs);

  const missed = await deps.prisma.schedule.findMany({
    where: { status: "scheduled", runAt: { lt: cutoff } },
    include: { workflow: { select: { name: true, userId: true } } }
  });

  for (const schedule of missed) {
    await deps.prisma.schedule.update({ where: { id: schedule.id }, data: { status: "failed" } });
    await deps.prisma.execution.updateMany({
      where: { scheduleId: schedule.id, status: "queued" },
      data: {
        status: "failed",
        finishedAt: new Date(),
        errorMessage: "The scheduled job was not started in time"
      }
    });
    await deps.notifications.notify(
      {
        userId: schedule.workflow.userId,
        type: "schedule_missed",
        title: "Esecuzione pianificata non avviata",
        message: `Il workflow "${schedule.workflow.name}" non è stato avviato all'orario previsto.`
      },
      (err) => deps.log.warn({ err }, "Notification delivery failed")
    );
  }

  if (missed.length > 0) {
    deps.log.warn({ count: missed.length }, "Reconciled missed schedules");
  }
  return missed.length;
}
