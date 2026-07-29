import { Worker, type Job } from "bullmq";
import IORedis, { type Redis } from "ioredis";
import type { PrismaClient, NotificationService } from "@app/database";
import type { Logger } from "@app/shared";
import type { WorkerConfig } from "./config";
import type { SessionManager } from "./session/manager";
import { runExecution } from "./runner/run-execution";

export const EXECUTION_QUEUE_NAME = "workflow-executions";

export interface ExecutionJobData {
  /**
   * The row this job advances. A run asked for by hand, and a one-shot
   * schedule, reserve it upfront so cancelling is a single lookup. A recurring
   * schedule cannot: it has no single run, so each occurrence makes its own row
   * when it fires, which is what `executionFor` does below.
   */
  executionId?: string;
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
      const executionId = await startOccurrence(job.data, deps);
      if (!executionId) {
        return { status: "failed" as const, errorMessage: "Skipped: the previous run is still in progress" };
      }
      const result = await runExecution({ ...job.data, executionId }, {
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
      concurrency: 1,
      /**
       * A job whose worker died is "stalled". By default BullMQ puts it back on
       * the queue and runs it again, which for this product means replaying a
       * workflow that already had an effect on the target site — placing an
       * order twice, for example. A workflow interrupted halfway must be
       * reported and left to the user, never repeated on its own.
       */
      maxStalledCount: 0
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
 * Closes executions that were in flight when the worker stopped.
 *
 * Only the worker can advance an execution, so anything still `starting` or
 * `running` at startup belonged to a process that no longer exists: a restart,
 * a crash or an out-of-memory kill. Left alone it stays "in progress" forever in
 * the UI, and its live log stream never ends.
 *
 * This assumes a single worker, which is what the MVP deploys. With several
 * workers it would have to be scoped to the executions this instance owned.
 */
/**
 * The execution row a job advances, creating it when the job did not bring one,
 * and refusing the occurrence when the workflow is already running.
 *
 * Only a recurring schedule arrives without a row: its occurrences are produced
 * by the queue on its own clock, so there is nothing to reserve when the
 * schedule is saved — the row is what says this particular occurrence happened.
 *
 * The refusal is the same rule as everywhere else in this product: a workflow
 * acts on a real site, so running it twice at once means doing the thing twice.
 * A run that takes longer than the interval would otherwise pile occurrences up
 * behind it and act on the site over and over, long after the hour they were
 * meant for. Skipping is the only honest answer — the next occurrence is
 * already on its way.
 */
export async function startOccurrence(
  data: ExecutionJobData,
  deps: { prisma: PrismaClient; log: Logger }
): Promise<string | null> {
  if (data.executionId) return data.executionId;

  const inFlight = await deps.prisma.execution.findFirst({
    where: {
      workflowId: data.workflowId,
      status: { in: ["queued", "starting", "running"] }
    },
    select: { id: true, status: true }
  });
  if (inFlight) {
    deps.log.warn(
      { workflowId: data.workflowId, scheduleId: data.scheduleId, executionId: inFlight.id },
      "Skipped a recurring occurrence: the previous run has not finished"
    );
    return null;
  }

  const execution = await deps.prisma.execution.create({
    data: {
      workflowId: data.workflowId,
      scheduleId: data.scheduleId ?? null,
      status: "queued"
    }
  });
  deps.log.info(
    { executionId: execution.id, scheduleId: data.scheduleId },
    "Created the execution row of a recurring occurrence"
  );
  return execution.id;
}

export async function reconcileOrphanedExecutions(deps: {
  prisma: PrismaClient;
  notifications: NotificationService;
  log: Logger;
}): Promise<number> {
  const orphans = await deps.prisma.execution.findMany({
    where: { status: { in: ["starting", "running"] } },
    include: { workflow: { select: { name: true, userId: true } } }
  });

  for (const execution of orphans) {
    const message = "The execution was interrupted: the worker stopped while it was running";
    await deps.prisma.execution.update({
      where: { id: execution.id },
      data: { status: "failed", finishedAt: new Date(), errorMessage: message }
    });
    await deps.prisma.executionLog.create({
      data: { executionId: execution.id, level: "error", message }
    });
    await deps.notifications.notify(
      {
        userId: execution.workflow.userId,
        type: "workflow_failed",
        title: "Workflow interrotto",
        message: `Il workflow "${execution.workflow.name}" è stato interrotto: il worker si è fermato durante l'esecuzione.`
      },
      (err) => deps.log.warn({ err }, "Notification delivery failed")
    );
  }

  if (orphans.length > 0) {
    deps.log.warn({ count: orphans.length }, "Closed executions orphaned by a worker restart");
  }
  return orphans.length;
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
    // A recurring schedule has no instant to be late for: its next occurrence
    // lives in the queue, and `runAt` is null.
    where: { status: "scheduled", cron: null, runAt: { lt: cutoff } },
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
