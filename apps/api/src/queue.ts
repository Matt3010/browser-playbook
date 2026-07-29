import { Queue, type JobsOptions } from "bullmq";
import IORedis, { type Redis } from "ioredis";

export const EXECUTION_QUEUE_NAME = "workflow-executions";

export interface ExecutionJobData {
  /**
   * The row this job advances. A one-shot schedule reserves it when it is
   * created, so cancelling is a single lookup; a recurring schedule has no row
   * to reserve — every occurrence makes its own when it fires — so this is
   * absent there and the worker creates it.
   */
  executionId?: string;
  workflowId: string;
  userId: string;
  scheduleId?: string | null;
}

/**
 * Producer side of the persistent execution queue. Jobs live in Redis so a
 * scheduled run survives a restart of any container.
 */
export class ExecutionQueue {
  private readonly connection: Redis;
  private readonly queue: Queue<ExecutionJobData>;

  constructor(redisUrl: string) {
    this.connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue<ExecutionJobData>(EXECUTION_QUEUE_NAME, {
      connection: this.connection,
      defaultJobOptions: {
        // The MVP explicitly stops at the first error: no automatic retries.
        attempts: 1,
        removeOnComplete: 500,
        removeOnFail: 500
      }
    });
  }

  async enqueueNow(data: ExecutionJobData): Promise<string> {
    const job = await this.queue.add("run", data, { jobId: data.executionId });
    return job.id as string;
  }

  /**
   * Creates or replaces the repeating job of a recurring schedule.
   *
   * Keyed by the schedule id, so saving the same schedule twice moves it rather
   * than leaving two behind — and the recurrence lives in Redis, which is what
   * makes it survive a restart of every container.
   */
  async upsertRecurring(
    scheduleId: string,
    cron: string,
    timezone: string,
    data: ExecutionJobData
  ): Promise<void> {
    await this.queue.upsertJobScheduler(
      scheduleId,
      { pattern: cron, tz: timezone },
      { name: "run", data }
    );
  }

  /**
   * Stops a recurring schedule for good.
   *
   * Removing the scheduler stops it producing new occurrences, but the next one
   * has already been placed in the queue by the time anyone cancels — the queue
   * works ahead. Left there it fires once more, minutes after the user was told
   * the schedule was cancelled, and the site is acted on again. So the pending
   * occurrence goes too; one already running is an execution of its own and is
   * left to finish.
   */
  async removeRecurring(scheduleId: string): Promise<boolean> {
    const removed = await this.queue.removeJobScheduler(scheduleId);
    const pending = await this.queue.getJobs(["delayed", "waiting", "paused"]);
    for (const job of pending) {
      if (job.repeatJobKey === scheduleId) {
        await job.remove().catch(() => undefined);
      }
    }
    return removed;
  }

  /** When the recurring schedule is due next, as the queue itself sees it. */
  async nextRunOf(scheduleId: string): Promise<Date | null> {
    const schedulers = await this.queue.getJobSchedulers();
    const found = schedulers.find((entry) => entry.key === scheduleId || entry.id === scheduleId);
    return found?.next ? new Date(found.next) : null;
  }

  async enqueueDelayed(data: ExecutionJobData, delayMs: number): Promise<string> {
    const opts: JobsOptions = { delay: delayMs, jobId: data.executionId };
    const job = await this.queue.add("run", data, opts);
    return job.id as string;
  }

  async cancel(jobId: string): Promise<boolean> {
    const job = await this.queue.getJob(jobId);
    if (!job) return false;
    const state = await job.getState();
    if (state === "completed" || state === "failed" || state === "active") {
      return false;
    }
    await job.remove();
    return true;
  }

  async getJobState(jobId: string): Promise<string | null> {
    const job = await this.queue.getJob(jobId);
    if (!job) return null;
    return job.getState();
  }

  async ping(): Promise<boolean> {
    const result = await this.connection.ping();
    return result === "PONG";
  }

  async close(): Promise<void> {
    await this.queue.close();
    this.connection.disconnect();
  }
}
