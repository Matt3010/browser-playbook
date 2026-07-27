import { createReadStream } from "fs";
import { stat } from "fs/promises";
import path from "path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { signSessionToken } from "@app/shared";
import { isRunnableStepList, StepSchema } from "@app/workflow-schema";
import { requireAuth, currentUser } from "../auth";
import { referenceState, unresolvedReferences } from "../references";
import { loadOwnedWorkflow, loadOwnedExecution } from "../ownership";
import { WorkerHttpError } from "../worker-client";

const ListQuerySchema = z.object({
  workflowId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

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
        pageOrigin: row.pageOrigin,
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
    const unresolved = unresolvedReferences(steps, await referenceState(app, userId));
    if (unresolved) {
      return reply.code(409).send(unresolved);
    }

    // A workflow acts on a real site, so running it twice means doing the thing
    // twice: placing the order again, sending the form again. Two clicks on the run
    // button are enough to get there, and the worker's concurrency of 1 does not
    // help — it only makes the second run happen after the first instead of beside
    // it. The refusal is the same reasoning behind maxStalledCount: 0.
    const inFlight = await app.prisma.execution.findFirst({
      where: {
        workflowId: workflow.id,
        status: { in: ["queued", "starting", "running"] },
        // A queued row whose schedule has not come due yet is a reservation made
        // when the schedule was created, not a run in progress. Treating it as one
        // would make a scheduled workflow impossible to run by hand.
        NOT: { status: "queued", schedule: { runAt: { gt: new Date() } } }
      },
      select: { id: true, status: true }
    });
    if (inFlight) {
      return reply.code(409).send({
        error:
          `This workflow is already running (execution ${inFlight.id}, ${inFlight.status}). ` +
          "Wait for it to finish or cancel it: running it twice would act on the target site twice.",
        executionId: inFlight.id
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

  /**
   * Stops an execution that has not finished yet.
   *
   * A queued one only needs its job removed. A running one also has a browser
   * session named after it, which must be released rather than left holding a
   * slot until its lifetime expires. The runner notices the `cancelled` status
   * and leaves it alone instead of overwriting it with a failure.
   */
  app.post<{ Params: { id: string } }>("/executions/:id/cancel", async (request, reply) => {
    const { userId } = currentUser(request);
    const execution = await loadOwnedExecution(app, userId, request.params.id);

    if (["completed", "failed", "cancelled"].includes(execution.status)) {
      return reply
        .code(409)
        .send({ error: `Cannot cancel an execution in state '${execution.status}'` });
    }

    const updated = await app.prisma.execution.update({
      where: { id: execution.id },
      data: {
        status: "cancelled",
        finishedAt: new Date(),
        errorMessage: "Cancelled by the user"
      }
    });

    await app.prisma.executionLog.create({
      data: {
        executionId: execution.id,
        level: "warn",
        message: "Execution cancelled by the user"
      }
    });

    // Remove the queue job if it has not been picked up yet.
    try {
      await app.queue.cancel(execution.id);
    } catch (err) {
      request.log.warn({ err, executionId: execution.id }, "Could not remove the queued job");
    }

    // Release the browser, if one is already running for this execution.
    try {
      await app.worker.closeSession(execution.id);
    } catch (err) {
      if (!(err instanceof WorkerHttpError && err.statusCode === 404)) {
        request.log.warn(
          { err, executionId: execution.id },
          "Could not close the browser session of a cancelled execution"
        );
      }
    }

    if (execution.scheduleId) {
      await app.prisma.schedule.updateMany({
        where: { id: execution.scheduleId, status: { in: ["scheduled", "queued"] } },
        data: { status: "cancelled" }
      });
    }

    return updated;
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

  /**
   * A ticket to watch the browser of a run that is happening right now.
   *
   * The runner drives a session whose id *is* the execution's, so the stream
   * has always existed — there was simply no way to ask for it: a VNC token is
   * minted when a session is created from the page, and nobody creates this
   * one. Everything the stream needs to be safe is already checked on the
   * upgrade: scope, session, owner and state.
   */
  app.get<{ Params: { id: string } }>("/executions/:id/vnc", async (request, reply) => {
    const { userId } = currentUser(request);
    const execution = await loadOwnedExecution(app, userId, request.params.id);

    let live: { userId: string; state: string };
    try {
      live = await app.worker.getSession(execution.id);
    } catch {
      return reply.code(404).send({ error: "This execution has no live browser" });
    }
    // Only once it is actually up: a session exists from the moment it is asked
    // for, but Xvfb, x11vnc and websockify take a few seconds to come up behind
    // it, and a ticket handed out before that buys a refused connection.
    if (live.userId !== userId || (live.state !== "ready" && live.state !== "running")) {
      return reply.code(404).send({ error: "This execution has no live browser" });
    }

    const token = signSessionToken(
      { sessionId: execution.id, userId, scope: "vnc" },
      app.config.jwtSecret,
      app.config.sessionTokenTtlSeconds
    );
    return {
      vncPath: `/api/sessions/${execution.id}/vnc?token=${encodeURIComponent(token)}`
    };
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

    // The separator matters: without it a sibling directory sharing the prefix
    // (`<root>-evil`) satisfies the check, and so does the root itself.
    const root = path.resolve(app.config.artifactDir);
    const resolved = path.resolve(artifact.path);
    if (!resolved.startsWith(root + path.sep)) {
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
