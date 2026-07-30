import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, PrismaClient, NotificationService } from "@app/database";
import { hashPassword, createLogger } from "@app/shared";
import { runExecution } from "../src/runner/run-execution";
import type { SessionManager } from "../src/session/manager";
import type { WorkerConfig } from "../src/config";

/**
 * The API refuses to start a workflow that references a credential which no longer
 * exists. For an immediate run that check is current; for a scheduled one it was
 * made when the schedule was created and can be days old by the time the job
 * fires. Nothing re-checked it, so the run opened a browser, performed the steps
 * that came before the template, and only then failed — leaving whatever those
 * steps did on the target site half done, at three in the morning.
 */
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL as string } }
});
const notifications = new NotificationService(prisma);
const log = createLogger("worker-preflight-test");

const config = {
  artifactDir: "/tmp/preflight-artifacts",
  uploadFixtureDir: "/tmp/preflight-uploads",
  credentialsEncKey: "0123456789abcdef0123456789abcdef",
  sessionTimeoutMs: 60_000,
  allowPrivateTargets: true,
  allowedTargetHosts: []
} as unknown as WorkerConfig;

let userId: string;
let workflowId: string;
let executionId: string;

/** Records whether the runner tried to open a browser at all. */
function fakeSessions() {
  const create = vi.fn().mockRejectedValue(new Error("no browser must be started"));
  return { manager: { create } as unknown as SessionManager, create };
}

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
    data: { email: "preflight@example.com", passwordHash: await hashPassword("TestPassword123!") }
  });
  userId = user.id;

  const workflow = await prisma.workflow.create({
    data: {
      userId,
      name: "Login pianificato",
      startUrl: "http://test-web:3001/login",
      status: "ready"
    }
  });
  workflowId = workflow.id;

  await prisma.workflowStep.createMany({
    data: [
      {
        workflowId,
        position: 0,
        type: "goto",
        name: "Vai al login",
        pageId: "main",
        selectorJson: Prisma.JsonNull,
        valueTemplate: "http://test-web:3001/login",
        timeoutMs: 15_000
      },
      {
        workflowId,
        position: 1,
        type: "fill",
        name: "Inserisci la password",
        pageId: "main",
        selectorJson: { strategy: "id", value: "password", pageId: "main" },
        // The credential this names is never created: it stands for one deleted
        // after the schedule was made.
        valueTemplate: "{{credentials.password_apple}}",
        timeoutMs: 15_000
      }
    ]
  });

  const execution = await prisma.execution.create({
    data: { workflowId, status: "queued" }
  });
  executionId = execution.id;
});

describe("checking references before opening a browser", () => {
  it("fails a run whose credential disappeared, without touching the site", async () => {
    const sessions = fakeSessions();

    const result = await runExecution(
      { executionId, workflowId, userId },
      { prisma, notifications, sessions: sessions.manager, config, log }
    );

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toMatch(/password_apple/);
    expect(sessions.create, "no browser may be started").not.toHaveBeenCalled();

    const stored = await prisma.execution.findUnique({ where: { id: executionId } });
    expect(stored!.status).toBe("failed");
    expect(stored!.finishedAt).not.toBeNull();

    const logs = await prisma.executionLog.findMany({ where: { executionId } });
    expect(logs.map((l) => l.message).join("\n")).toMatch(/password_apple/);
  });

  it("tells the owner why the scheduled run never happened", async () => {
    const sessions = fakeSessions();
    const schedule = await prisma.schedule.create({
      data: {
        workflowId,
        runAt: new Date(Date.now() - 1000),
        timezone: "Europe/Rome",
        status: "scheduled"
      }
    });
    await prisma.execution.update({
      where: { id: executionId },
      data: { scheduleId: schedule.id }
    });

    await runExecution(
      { executionId, workflowId, userId, scheduleId: schedule.id },
      { prisma, notifications, sessions: sessions.manager, config, log }
    );

    const settled = await prisma.schedule.findUnique({ where: { id: schedule.id } });
    expect(settled!.status).toBe("failed");
    const notes = await prisma.notification.findMany({ where: { userId } });
    expect(notes.length).toBeGreaterThan(0);
  });

  it("runs normally when every reference resolves", async () => {
    // The credential exists now, so the pre-flight must let the run proceed: it is
    // the fake session manager that stops it, not the check.
    const { encryptSecret } = await import("@app/shared");
    await prisma.credential.create({
      data: {
        userId,
        name: "password_apple",
        kind: "secret",
        encryptedValue: encryptSecret("hunter2", config.credentialsEncKey)
      }
    });
    const sessions = fakeSessions();

    const result = await runExecution(
      { executionId, workflowId, userId },
      { prisma, notifications, sessions: sessions.manager, config, log }
    );

    expect(sessions.create, "the run must reach the browser").toHaveBeenCalled();
    expect(result.status).toBe("failed");
    expect(result.errorMessage).not.toMatch(/password_apple/);
  });
});

describe("an outcome already decided is not hidden by the cancellation that follows it", () => {
  it("keeps the reason the run really stopped", async () => {
    /*
     * Seen on a live run: the step failed at 09:59:16 and the user pressed Annulla
     * at 09:59:23, while the runner was still photographing the failure. `finish`
     * then found the row already `cancelled` and declined to touch it — deliberately,
     * because a cancellation must survive the failure it *causes* — so the row read
     * "Cancelled by the user" and the timeout that had already decided the outcome
     * survived only in the log. The operator is told they stopped something that
     * had stopped by itself.
     *
     * The status stays `cancelled`: they did press it, and a terminal state must not
     * be rewritten underneath them. What must not be lost is the reason.
     */
    // The reference check must not be what stops this run: the step naming a
    // credential nobody created is removed, so the run gets as far as the browser.
    await prisma.workflowStep.deleteMany({ where: { workflowId, position: 1 } });

    /*
     * The order is the whole point, so it is reproduced rather than asserted about.
     * The failure is decided first — `create` throws — and the cancellation lands
     * afterwards, while the runner is writing the outcome. On the live run that gap
     * was seven seconds of screenshotting; here it is the log line the runner writes
     * on its way to `finish`, which is the same gap with a shorter clock.
     */
    const prismaCancellingMidCleanup = new Proxy(prisma, {
      get(target, prop) {
        if (prop !== "executionLog") return Reflect.get(target, prop, target);
        return {
          create: async (args: { data: { message?: string } }) => {
            if (args.data.message?.includes("Execution aborted")) {
              await target.execution.update({
                where: { id: executionId },
                data: {
                  status: "cancelled",
                  finishedAt: new Date(),
                  errorMessage: "Cancelled by the user"
                }
              });
            }
            return target.executionLog.create(args as never);
          }
        };
      }
    }) as PrismaClient;

    await runExecution(
      { executionId, workflowId, userId },
      {
        prisma: prismaCancellingMidCleanup,
        notifications,
        sessions: {
          create: vi.fn().mockRejectedValue(new Error("page.goto: Timeout 10000ms exceeded"))
        } as unknown as SessionManager,
        config,
        log
      }
    );

    const stored = await prisma.execution.findUnique({ where: { id: executionId } });
    expect(stored!.status, "the user did press cancel, and that stands").toBe("cancelled");
    expect(
      stored!.errorMessage ?? "",
      "the reason the run actually stopped must survive the cancellation"
    ).toMatch(/Timeout 10000ms exceeded/);
  });

  it("still says only that it was cancelled when the cancellation is the whole story", async () => {
    // The other direction, and the reason the original guard exists: cancelling
    // closes the browser out from under the running step, so that step fails with
    // "Target page, context or browser has been closed" — reporting which would
    // bury the fact that the user asked for it. Here the cancellation is already in
    // place when the failure is decided, which is exactly how that case looks.
    await prisma.workflowStep.deleteMany({ where: { workflowId, position: 1 } });

    const cancelThenFail = vi.fn().mockImplementation(async () => {
      await prisma.execution.update({
        where: { id: executionId },
        data: {
          status: "cancelled",
          finishedAt: new Date(),
          errorMessage: "Cancelled by the user"
        }
      });
      throw new Error("Target page, context or browser has been closed");
    });

    await runExecution(
      { executionId, workflowId, userId },
      {
        prisma,
        notifications,
        sessions: { create: cancelThenFail } as unknown as SessionManager,
        config,
        log
      }
    );

    const stored = await prisma.execution.findUnique({ where: { id: executionId } });
    expect(stored!.status).toBe("cancelled");
    expect(
      stored!.errorMessage,
      "a failure the cancellation caused must not be reported as the reason"
    ).toBe("Cancelled by the user");
  });
});
