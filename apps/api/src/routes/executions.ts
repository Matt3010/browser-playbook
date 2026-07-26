import { createReadStream } from "fs";
import { stat } from "fs/promises";
import path from "path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  describeMissingReferences,
  findMissingReferences,
  isRunnableStepList,
  StepSchema
} from "@app/workflow-schema";
import { requireAuth, currentUser } from "../auth";
import { loadOwnedWorkflow, loadOwnedExecution } from "../ownership";

const ListQuerySchema = z.object({
  workflowId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

/** Artifacts live on a shared volume; only paths inside it may be served. */
const ARTIFACT_ROOT = process.env.ARTIFACT_DIR ?? "/data/artifacts";

/**
 * Loads the names of the values a workflow can reference. Kept separate so both
 * the immediate-run and the scheduling route check the same thing.
 */
async function availableValues(app: FastifyInstance, userId: string) {
  const rows = await app.prisma.credential.findMany({
    where: { userId },
    select: { name: true, kind: true }
  });
  return {
    variables: rows.filter((r) => r.kind === "variable").map((r) => r.name),
    credentials: rows.filter((r) => r.kind === "secret").map((r) => r.name)
  };
}

export async function executionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  /** Runs a workflow immediately by enqueueing it with no delay. */
  app.post<{ Params: { id: string } }>("/workflows/:id/executions", async (request, reply) => {
    const { userId } = currentUser(request);
    const workflow = await loadOwnedWorkflow(app, userId, request.params.id);

    if (workflow.status === "disabled") {
      return reply.code(409).send({ error: "Workflow is disabled" });
    }
    const stepRows = await app.prisma.workflowStep.findMany({
      where: { workflowId: workflow.id },
      orderBy: { position: "asc" }
    });
    const steps = stepRows.map((row) =>
      StepSchema.parse({
        id: row.id,
        type: row.type,
        name: row.name,
        pageId: row.pageId,
        selector: row.selectorJson ?? null,
        value: row.valueTemplate,
        timeoutMs: row.timeoutMs,
        enabled: row.enabled,
        isFinal: row.isFinal
      })
    );
    if (!isRunnableStepList(steps)) {
      return reply.code(409).send({ error: "Workflow has no enabled steps to run" });
    }

    // Refuse before starting a browser: a reference to a deleted credential would
    // otherwise only surface halfway through the run, after earlier steps already
    // had an effect on the target site.
    const missing = findMissingReferences(steps, await availableValues(app, userId));
    if (missing.length > 0) {
      return reply.code(409).send({
        error: `The workflow references values that do not exist: ${describeMissingReferences(missing)}`,
        missingReferences: missing
      });
    }

    const execution = await app.prisma.execution.create({
      data: { workflowId: workflow.id, status: "queued" }
    });

    try {
      await app.queue.enqueueNow({
        executionId: execution.id,
        workflowId: workflow.id,
        userId
      });
    } catch (err) {
      // The row exists but no job does. Left as `queued` it would show up as
      // pending forever, never running and never failing, so it is closed here.
      app.log.error({ err, executionId: execution.id }, "Failed to enqueue execution");
      const failed = await app.prisma.execution.update({
        where: { id: execution.id },
        data: {
          status: "failed",
          finishedAt: new Date(),
          errorMessage: "Could not enqueue the execution job"
        }
      });
      await app.prisma.executionLog.create({
        data: {
          executionId: failed.id,
          level: "error",
          message: "Could not enqueue the execution job: the queue is unavailable"
        }
      });
      return reply.code(503).send({ error: "Could not enqueue the execution job" });
    }

    return reply.code(202).send(execution);
  });

  app.get("/executions", async (request, reply) => {
    const { userId } = currentUser(request);
    const parsed = ListQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid query" });

    return app.prisma.execution.findMany({
      where: {
        workflow: { userId },
        ...(parsed.data.workflowId ? { workflowId: parsed.data.workflowId } : {})
      },
      orderBy: { createdAt: "desc" },
      take: parsed.data.limit,
      include: { workflow: { select: { id: true, name: true } } }
    });
  });

  app.get<{ Params: { id: string } }>("/executions/:id", async (request) => {
    const { userId } = currentUser(request);
    const execution = await loadOwnedExecution(app, userId, request.params.id);
    const [logs, artifacts] = await Promise.all([
      app.prisma.executionLog.findMany({
        where: { executionId: execution.id },
        orderBy: { createdAt: "asc" }
      }),
      app.prisma.artifact.findMany({ where: { executionId: execution.id } })
    ]);
    const durationMs =
      execution.startedAt && execution.finishedAt
        ? execution.finishedAt.getTime() - execution.startedAt.getTime()
        : null;
    return { ...execution, durationMs, logs, artifacts };
  });

  /**
   * Live log stream. Polls the execution log table and pushes new rows as SSE
   * events until the execution reaches a terminal state.
   */
  app.get<{ Params: { id: string } }>("/executions/:id/logs/stream", async (request, reply) => {
    const { userId } = currentUser(request);
    const execution = await loadOwnedExecution(app, userId, request.params.id);

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    reply.hijack();

    let closed = false;
    let cursor: Date | null = null;
    let lastSeenIds = new Set<string>();

    const send = (event: string, data: unknown) => {
      if (closed) return;
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      reply.raw.end();
    };

    request.raw.on("close", cleanup);

    const tick = async () => {
      if (closed) return;
      try {
        const logs = await app.prisma.executionLog.findMany({
          where: {
            executionId: execution.id,
            ...(cursor ? { createdAt: { gte: cursor } } : {})
          },
          orderBy: { createdAt: "asc" },
          take: 200
        });
        for (const log of logs) {
          if (lastSeenIds.has(log.id)) continue;
          send("log", {
            id: log.id,
            stepId: log.stepId,
            level: log.level,
            message: log.message,
            createdAt: log.createdAt
          });
        }
        if (logs.length > 0) {
          const newest = logs[logs.length - 1].createdAt;
          // Keep the ids seen at the cursor timestamp to avoid duplicates when
          // several rows share the same millisecond.
          lastSeenIds = new Set(
            logs.filter((l) => l.createdAt.getTime() === newest.getTime()).map((l) => l.id)
          );
          cursor = newest;
        }

        const current = await app.prisma.execution.findUnique({
          where: { id: execution.id },
          select: { status: true, errorMessage: true, failedStepId: true, currentUrl: true }
        });
        if (current) {
          send("status", current);
          if (["completed", "failed", "cancelled"].includes(current.status)) {
            send("end", { status: current.status });
            cleanup();
          }
        }
      } catch (err) {
        app.log.error({ err }, "SSE log stream failed");
        cleanup();
      }
    };

    const timer = setInterval(tick, 500);
    await tick();
  });

  /** Serves a stored artifact (error screenshot, downloaded file). */
  app.get<{ Params: { id: string } }>("/artifacts/:id/file", async (request, reply) => {
    const { userId } = currentUser(request);
    const artifact = await app.prisma.artifact.findFirst({
      where: { id: request.params.id, execution: { workflow: { userId } } }
    });
    if (!artifact) return reply.code(404).send({ error: "Artifact not found" });

    const resolved = path.resolve(artifact.path);
    if (!resolved.startsWith(path.resolve(ARTIFACT_ROOT))) {
      return reply.code(400).send({ error: "Artifact path outside the artifact directory" });
    }
    try {
      await stat(resolved);
    } catch {
      return reply.code(404).send({ error: "Artifact file missing on disk" });
    }
    const contentType = resolved.endsWith(".png")
      ? "image/png"
      : resolved.endsWith(".txt")
        ? "text/plain"
        : "application/octet-stream";
    return reply.type(contentType).send(createReadStream(resolved));
  });
}
