import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient, NotificationService } from "@app/database";
import { hashPassword, createLogger } from "@app/shared";
import { reconcileMissedSchedules } from "../src/queue-consumer";

/**
 * A scheduled job can be lost if Redis is wiped while the stack is down. The
 * worker reconciles those schedules at startup so they do not stay pending
 * forever, and notifies the owner that the run never started.
 */
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL as string } }
});
const notifications = new NotificationService(prisma);
const log = createLogger("worker-test");

let userId: string;
let workflowId: string;

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
    data: { email: "reconcile@example.com", passwordHash: await hashPassword("TestPassword123!") }
  });
  userId = user.id;

  const workflow = await prisma.workflow.create({
    data: {
      userId,
      name: "Workflow pianificato",
      startUrl: "http://test-web:3001/login",
      status: "ready"
    }
  });
  workflowId = workflow.id;
});

async function createSchedule(runAt: Date, status: "scheduled" | "cancelled" = "scheduled") {
  const schedule = await prisma.schedule.create({
    data: { workflowId, runAt, timezone: "Europe/Rome", status }
  });
  const execution = await prisma.execution.create({
    data: { workflowId, scheduleId: schedule.id, status: "queued" }
  });
  return { schedule, execution };
}

describe("missed schedule reconciliation", () => {
  it("fails an overdue schedule, fails its execution and notifies the owner", async () => {
    const { schedule, execution } = await createSchedule(new Date(Date.now() - 10 * 60_000));

    const count = await reconcileMissedSchedules({ prisma, notifications, log });
    expect(count).toBe(1);

    const updatedSchedule = await prisma.schedule.findUnique({ where: { id: schedule.id } });
    expect(updatedSchedule!.status).toBe("failed");

    const updatedExecution = await prisma.execution.findUnique({ where: { id: execution.id } });
    expect(updatedExecution!.status).toBe("failed");
    expect(updatedExecution!.finishedAt).not.toBeNull();
    expect(updatedExecution!.errorMessage).toMatch(/not started in time/i);

    const created = await prisma.notification.findMany({ where: { userId } });
    expect(created).toHaveLength(1);
    expect(created[0].type).toBe("schedule_missed");
    expect(created[0].title).toContain("non avviata");
    expect(created[0].message).toContain("Workflow pianificato");
  });

  it("leaves a schedule inside the grace period alone", async () => {
    const { schedule, execution } = await createSchedule(new Date(Date.now() - 5_000));

    const count = await reconcileMissedSchedules({ prisma, notifications, log, graceMs: 60_000 });
    expect(count).toBe(0);

    expect((await prisma.schedule.findUnique({ where: { id: schedule.id } }))!.status).toBe(
      "scheduled"
    );
    expect((await prisma.execution.findUnique({ where: { id: execution.id } }))!.status).toBe(
      "queued"
    );
    expect(await prisma.notification.count()).toBe(0);
  });

  it("ignores future schedules", async () => {
    await createSchedule(new Date(Date.now() + 10 * 60_000));
    expect(await reconcileMissedSchedules({ prisma, notifications, log })).toBe(0);
    expect(await prisma.notification.count()).toBe(0);
  });

  it("ignores schedules that are no longer pending", async () => {
    await createSchedule(new Date(Date.now() - 10 * 60_000), "cancelled");
    expect(await reconcileMissedSchedules({ prisma, notifications, log })).toBe(0);
    expect(await prisma.notification.count()).toBe(0);
  });

  it("reconciles several missed schedules in one pass", async () => {
    await createSchedule(new Date(Date.now() - 10 * 60_000));
    await createSchedule(new Date(Date.now() - 20 * 60_000));

    expect(await reconcileMissedSchedules({ prisma, notifications, log })).toBe(2);
    expect(await prisma.notification.count()).toBe(2);
    expect(await prisma.schedule.count({ where: { status: "failed" } })).toBe(2);
  });
});
