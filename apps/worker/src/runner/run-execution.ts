import { mkdir } from "fs/promises";
import path from "path";
import {
  type PrismaClient,
  type NotificationService,
  type ExecutionStatus
} from "@app/database";
import {
  decryptSecret,
  maskSecrets,
  type Logger,
  type TemplateContext
} from "@app/shared";
import { StepSchema, type Step } from "@app/workflow-schema";
import type { WorkerConfig } from "../config";
import type { SessionManager } from "../session/manager";
import type { BrowserSession } from "../session/session";
import { executeStep, type StepExecutionContext } from "./execute-step";

export interface RunExecutionInput {
  executionId: string;
  workflowId: string;
  userId: string;
  scheduleId?: string | null;
}

export interface RunExecutionDeps {
  prisma: PrismaClient;
  notifications: NotificationService;
  sessions: SessionManager;
  config: WorkerConfig;
  log: Logger;
}

export interface RunExecutionResult {
  status: "completed" | "failed";
  failedStepId?: string | null;
  errorMessage?: string | null;
}

function rowToStep(row: {
  id: string;
  type: string;
  name: string;
  pageId: string;
  selectorJson: unknown;
  valueTemplate: string | null;
  timeoutMs: number;
  enabled: boolean;
  isFinal: boolean;
}): Step {
  return StepSchema.parse({
    id: row.id,
    type: row.type,
    name: row.name,
    pageId: row.pageId,
    selector: row.selectorJson ?? null,
    value: row.valueTemplate,
    timeoutMs: row.timeoutMs,
    enabled: row.enabled,
    isFinal: row.isFinal
  });
}

/**
 * Runs one execution from start to finish.
 *
 * The execution stops at the first failing step: nothing after it is attempted,
 * an error screenshot and the recent logs are stored, and an in-app notification
 * is created. Secret values are masked everywhere they could surface.
 */
export async function runExecution(
  input: RunExecutionInput,
  deps: RunExecutionDeps
): Promise<RunExecutionResult> {
  const { prisma, notifications, sessions, config } = deps;
  const log = deps.log.child({ executionId: input.executionId, workflowId: input.workflowId });

  const execution = await prisma.execution.findUnique({ where: { id: input.executionId } });
  if (!execution) {
    log.warn("Execution row disappeared before the job ran");
    return { status: "failed", errorMessage: "Execution not found" };
  }
  if (execution.status === "cancelled") {
    log.info("Execution was cancelled before it started");
    return { status: "failed", errorMessage: "Execution cancelled" };
  }

  const workflow = await prisma.workflow.findUnique({ where: { id: input.workflowId } });
  if (!workflow) {
    await finish(prisma, input.executionId, "failed", { errorMessage: "Workflow not found" });
    return { status: "failed", errorMessage: "Workflow not found" };
  }

  // Secrets are needed to render templates, and are collected so that they can
  // be stripped from any message that gets persisted.
  const credentialRows = await prisma.credential.findMany({ where: { userId: input.userId } });
  const templates: TemplateContext = { variables: {}, credentials: {} };
  const secretValues: string[] = [];
  for (const row of credentialRows) {
    const value = decryptSecret(row.encryptedValue, config.credentialsEncKey);
    if (row.kind === "secret") {
      templates.credentials[row.name] = value;
      secretValues.push(value);
    } else {
      templates.variables[row.name] = value;
    }
  }

  const stepRows = await prisma.workflowStep.findMany({
    where: { workflowId: workflow.id },
    orderBy: { position: "asc" }
  });
  const steps = stepRows.map(rowToStep).filter((s) => s.enabled);

  const executionDir = path.join(config.artifactDir, input.executionId);
  await mkdir(executionDir, { recursive: true });

  const safe = (message: string) => maskSecrets(message, secretValues);

  const writeLog = async (
    level: "info" | "warn" | "error",
    message: string,
    stepId?: string | null
  ) => {
    const clean = safe(message);
    log[level]({ stepId }, clean);
    await prisma.executionLog.create({
      data: { executionId: input.executionId, stepId: stepId ?? null, level, message: clean }
    });
  };

  await prisma.execution.update({
    where: { id: input.executionId },
    data: { status: "starting", startedAt: new Date() }
  });

  if (input.scheduleId) {
    await prisma.schedule.update({
      where: { id: input.scheduleId },
      data: { status: "queued" }
    });
    await notifications.notify(
      {
        userId: input.userId,
        type: "schedule_started",
        title: "Esecuzione pianificata avviata",
        message: `Il workflow "${workflow.name}" è stato avviato come da pianificazione.`
      },
      (err) => log.warn({ err }, "Notification delivery failed")
    );
  }

  if (steps.length === 0) {
    await writeLog("error", "The workflow has no enabled steps");
    await finish(prisma, input.executionId, "failed", {
      errorMessage: "The workflow has no enabled steps"
    });
    await notifyFailure(notifications, input.userId, workflow.name, "Nessuno step abilitato", log);
    if (input.scheduleId) await settleSchedule(prisma, input.scheduleId, "failed");
    return { status: "failed", errorMessage: "The workflow has no enabled steps" };
  }

  let session: BrowserSession | null = null;
  const startedAt = Date.now();

  try {
    await writeLog("info", `Starting execution of "${workflow.name}" with ${steps.length} steps`);

    session = await sessions.create({
      sessionId: input.executionId,
      userId: input.userId,
      startUrl: firstUrl(steps) ?? workflow.startUrl,
      timeoutMs: config.sessionTimeoutMs,
      // Nothing polls an execution's session from outside, so it must never be
      // reaped as idle: it lives exactly as long as the execution does.
      idleTimeoutMs: null
    });
    // The session is visible over noVNC while the execution runs.
    await session.setHighlight(false);

    await prisma.execution.update({
      where: { id: input.executionId },
      data: { status: "running", currentUrl: session.currentUrl }
    });

    const ctx: StepExecutionContext = {
      session,
      templates,
      urlSafety: {
        allowPrivateTargets: config.allowPrivateTargets,
        allowedHosts: config.allowedTargetHosts
      },
      uploadFixtureDir: config.uploadFixtureDir,
      artifactDir: config.artifactDir,
      executionId: input.executionId,
      onArtifact: async (artifact) => {
        await prisma.artifact.create({
          data: {
            executionId: input.executionId,
            type: artifact.type,
            path: artifact.path
          }
        });
      },
      log: (level, message) => writeLog(level, message)
    };

    for (const [index, step] of steps.entries()) {
      if (await wasCancelled(prisma, input.executionId)) {
        await writeLog("warn", "Execution cancelled: the remaining steps are not run");
        return { status: "failed", errorMessage: "Execution cancelled" };
      }
      const stepStart = Date.now();
      await writeLog("info", `Step ${index + 1}/${steps.length}: ${step.name} (${step.type})`, step.id);

      try {
        await executeStep(step, ctx);
      } catch (err) {
        const message = safe((err as Error).message);
        await handleFailure({
          prisma,
          notifications,
          session,
          executionId: input.executionId,
          userId: input.userId,
          workflowName: workflow.name,
          step,
          message,
          executionDir,
          writeLog,
          log
        });
        if (input.scheduleId) await settleSchedule(prisma, input.scheduleId, "failed");
        return { status: "failed", failedStepId: step.id, errorMessage: message };
      }

      const stepMs = Date.now() - stepStart;
      await writeLog("info", `Step ${index + 1} completed in ${stepMs} ms`, step.id);
      await prisma.execution.update({
        where: { id: input.executionId },
        data: { currentUrl: session.currentUrl }
      });
    }

    const totalMs = Date.now() - startedAt;
    await writeLog("info", `Execution completed in ${totalMs} ms`);
    await finish(prisma, input.executionId, "completed", { currentUrl: session.currentUrl });

    await notifications.notify(
      {
        userId: input.userId,
        type: "workflow_completed",
        title: "Workflow completato",
        message: `Il workflow "${workflow.name}" è terminato con successo in ${totalMs} ms.`
      },
      (err) => log.warn({ err }, "Notification delivery failed")
    );
    if (input.scheduleId) await settleSchedule(prisma, input.scheduleId, "completed");
    return { status: "completed" };
  } catch (err) {
    // Failures outside a step (for example the browser session itself).
    const message = safe((err as Error).message);
    log.error({ err }, "Execution failed outside step execution");
    await prisma.executionLog.create({
      data: {
        executionId: input.executionId,
        level: "error",
        message: `Execution aborted: ${message}`
      }
    });
    await finish(prisma, input.executionId, "failed", { errorMessage: message });
    await notifyFailure(notifications, input.userId, workflow.name, message, log);
    if (input.scheduleId) await settleSchedule(prisma, input.scheduleId, "failed");
    return { status: "failed", errorMessage: message };
  } finally {
    if (session) {
      try {
        await session.close();
      } catch (err) {
        log.warn({ err }, "Error closing the execution browser session");
      }
    }
  }
}

function firstUrl(steps: Step[]): string | null {
  const first = steps[0];
  if (first?.type === "goto" && first.value && !first.value.includes("{{")) return first.value;
  return null;
}

/**
 * True when the user cancelled the execution while it was running. The API sets
 * the status and closes the browser, which makes the current step fail; that
 * failure must not overwrite the cancellation with a generic error.
 */
async function wasCancelled(prisma: PrismaClient, executionId: string): Promise<boolean> {
  const current = await prisma.execution.findUnique({
    where: { id: executionId },
    select: { status: true }
  });
  return current?.status === "cancelled";
}

async function finish(
  prisma: PrismaClient,
  executionId: string,
  status: Extract<ExecutionStatus, "completed" | "failed">,
  extra: { errorMessage?: string; failedStepId?: string; currentUrl?: string | null }
): Promise<void> {
  if (await wasCancelled(prisma, executionId)) return;
  await prisma.execution.update({
    where: { id: executionId },
    data: {
      status,
      finishedAt: new Date(),
      errorMessage: extra.errorMessage ?? null,
      failedStepId: extra.failedStepId ?? null,
      ...(extra.currentUrl !== undefined ? { currentUrl: extra.currentUrl } : {})
    }
  });
}

async function settleSchedule(
  prisma: PrismaClient,
  scheduleId: string,
  status: "completed" | "failed"
): Promise<void> {
  await prisma.schedule.update({ where: { id: scheduleId }, data: { status } });
}

async function notifyFailure(
  notifications: NotificationService,
  userId: string,
  workflowName: string,
  message: string,
  log: Logger
): Promise<void> {
  await notifications.notify(
    {
      userId,
      type: "workflow_failed",
      title: "Workflow fallito",
      message: `Il workflow "${workflowName}" si è interrotto: ${message}`
    },
    (err) => log.warn({ err }, "Notification delivery failed")
  );
}

interface FailureInput {
  prisma: PrismaClient;
  notifications: NotificationService;
  session: BrowserSession;
  executionId: string;
  userId: string;
  workflowName: string;
  step: Step;
  message: string;
  executionDir: string;
  writeLog: (
    level: "info" | "warn" | "error",
    message: string,
    stepId?: string | null
  ) => Promise<void>;
  log: Logger;
}

async function handleFailure(input: FailureInput): Promise<void> {
  const { prisma, session, step, executionId, executionDir } = input;

  const currentUrl = session.currentUrl;
  await input.writeLog("error", `Step failed: ${input.message}`, step.id);

  let screenshotPath: string | null = null;
  try {
    const page = session.getPage(step.pageId) ?? session.getActivePage();
    if (page) {
      screenshotPath = path.join(executionDir, `error-${step.id}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false, timeout: 15_000 });
      await prisma.artifact.create({
        data: { executionId, type: "screenshot", path: screenshotPath }
      });
      await input.writeLog("info", "Saved the error screenshot", step.id);
    }
  } catch (err) {
    input.log.warn({ err }, "Could not capture the error screenshot");
    screenshotPath = null;
  }

  if (await wasCancelled(prisma, executionId)) {
    input.log.info("Execution was cancelled while this step was running");
    return;
  }

  await prisma.execution.update({
    where: { id: executionId },
    data: {
      status: "failed",
      finishedAt: new Date(),
      errorMessage: input.message,
      failedStepId: step.id,
      currentUrl
    }
  });

  await notifyFailure(
    input.notifications,
    input.userId,
    input.workflowName,
    `step "${step.name}" - ${input.message}`,
    input.log
  );
}
