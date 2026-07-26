import { Queue, type JobsOptions } from "bullmq";
import IORedis, { type Redis } from "ioredis";

export const EXECUTION_QUEUE_NAME = "workflow-executions";

export interface ExecutionJobData {
  executionId: string;
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
