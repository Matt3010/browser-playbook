import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@app/database";
import { hashPassword, createLogger } from "@app/shared";
import { startOccurrence } from "../src/queue-consumer";

/**
 * An occurrence of a recurring schedule. Unlike a run asked for by hand, or a
 * one-shot schedule, nothing is reserved for it when the schedule is saved: the
 * queue produces it on its own clock, and the row that says it happened has to
 * be made here — or refused, when the workflow is already running.
 */
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL as string } }
});
const log = createLogger("worker-test");

let userId: string;
let workflowId: string;
let scheduleId: string;

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "artifacts", "execution_logs", "executions", "schedules",
       "workflow_steps", "workflows", "credentials", "notifications", "users"
     RESTART IDENTITY CASCADE`
  );

  const user = await prisma.user.create({
    data: { email: "recurring@example.com", passwordHash: await hashPassword("TestPassword123!") }
  });
  userId = user.id;

  const workflow = await prisma.workflow.create({
    data: {
      userId,
      name: "Workflow ricorrente",
      startUrl: "http://test-web:3001/elements",
      status: "ready"
    }
  });
  workflowId = workflow.id;

  const schedule = await prisma.schedule.create({
    data: { workflowId, cron: "*/5 * * * *", timezone: "Europe/Rome", status: "scheduled" }
  });
  scheduleId = schedule.id;
});

const job = () => ({ workflowId, userId, scheduleId });

describe("an occurrence of a recurring schedule", () => {
  it("creates the row that says this occurrence happened", async () => {
    const executionId = await startOccurrence(job(), { prisma, log });

    expect(executionId).toBeTruthy();
    const stored = await prisma.execution.findUnique({ where: { id: executionId as string } });
    expect(stored).toMatchObject({ workflowId, scheduleId, status: "queued" });
  });

  it("makes a new row every time, so each occurrence has its own history", async () => {
    const first = await startOccurrence(job(), { prisma, log });
    await prisma.execution.update({
      where: { id: first as string },
      data: { status: "completed", finishedAt: new Date() }
    });
    const second = await startOccurrence(job(), { prisma, log });

    expect(second).not.toBe(first);
    expect(await prisma.execution.count({ where: { workflowId } })).toBe(2);
  });

  it("refuses the occurrence while the previous run is still going", async () => {
    // A workflow acts on a real site, so running it twice at once means doing
    // the thing twice. A run slower than the interval would otherwise pile
    // occurrences up behind it and act on the site long after their hour.
    await prisma.execution.create({ data: { workflowId, status: "running" } });

    const executionId = await startOccurrence(job(), { prisma, log });

    expect(executionId).toBeNull();
    expect(
      await prisma.execution.count({ where: { workflowId } }),
      "nothing may be queued behind a run in progress"
    ).toBe(1);
  });

  it("resumes once the previous run has finished", async () => {
    const running = await prisma.execution.create({ data: { workflowId, status: "running" } });
    expect(await startOccurrence(job(), { prisma, log })).toBeNull();

    await prisma.execution.update({
      where: { id: running.id },
      data: { status: "completed", finishedAt: new Date() }
    });

    expect(await startOccurrence(job(), { prisma, log })).toBeTruthy();
  });

  it("leaves a job that already carries its row alone", async () => {
    // A run asked for by hand, or a one-shot schedule: the row exists and this
    // must not invent a second one, nor refuse it.
    const reserved = await prisma.execution.create({ data: { workflowId, status: "queued" } });

    const executionId = await startOccurrence(
      { ...job(), executionId: reserved.id },
      { prisma, log }
    );

    expect(executionId).toBe(reserved.id);
    expect(await prisma.execution.count({ where: { workflowId } })).toBe(1);
  });
});
