import type { FastifyInstance } from "fastify";
import { validateSchedule, isRunnableStepList, StepSchema } from "@app/workflow-schema";
import { requireAuth, currentUser } from "../auth";
import { loadOwnedWorkflow, loadOwnedSchedule } from "../ownership";

export async function scheduleRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  /**
   * Schedules a single future execution. The execution row is created upfront in
   * `queued` state and its id is used as the queue job id, so cancelling is a
   * single lookup and the job survives restarts (it lives in Redis).
   */
  app.post<{ Params: { id: string } }>("/workflows/:id/schedules", async (request, reply) => {
    const { userId } = currentUser(request);
    const workflow = await loadOwnedWorkflow(app, userId, request.params.id);

    if (workflow.status === "disabled") {
      return reply.code(409).send({ error: "Workflow is disabled" });
    }

    const validation = validateSchedule(request.body);
    if (!validation.valid) {
      return reply.code(400).send({ error: "Invalid schedule", details: validation.errors });
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

    const { runAt, timezone } = request.body as { runAt: string; timezone: string };

    const schedule = await app.prisma.schedule.create({
      data: { workflowId: workflow.id, runAt: new Date(runAt), timezone, status: "scheduled" }
    });
    const execution = await app.prisma.execution.create({
      data: { workflowId: workflow.id, scheduleId: schedule.id, status: "queued" }
    });

    try {
      const jobId = await app.queue.enqueueDelayed(
        {
          executionId: execution.id,
          workflowId: workflow.id,
          userId,
          scheduleId: schedule.id
        },
        validation.delayMs as number
      );
      const updated = await app.prisma.schedule.update({
        where: { id: schedule.id },
        data: { queueJobId: jobId }
      });
      return reply.code(201).send({ ...updated, executionId: execution.id });
    } catch (err) {
      // Never leave a schedule pointing at a job that was not persisted.
      await app.prisma.schedule.update({
        where: { id: schedule.id },
        data: { status: "failed" }
      });
      await app.prisma.execution.update({
        where: { id: execution.id },
        data: { status: "failed", errorMessage: "Could not enqueue the scheduled job" }
      });
      app.log.error({ err }, "Failed to enqueue scheduled execution");
      return reply.code(503).send({ error: "Could not enqueue the scheduled job" });
    }
  });

  app.get<{ Params: { id: string } }>("/workflows/:id/schedules", async (request) => {
    const { userId } = currentUser(request);
    const workflow = await loadOwnedWorkflow(app, userId, request.params.id);
    return app.prisma.schedule.findMany({
      where: { workflowId: workflow.id },
      orderBy: { runAt: "desc" },
      include: { executions: { select: { id: true, status: true } } }
    });
  });

  app.get<{ Params: { id: string } }>("/schedules/:id", async (request) => {
    const { userId } = currentUser(request);
    const schedule = await loadOwnedSchedule(app, userId, request.params.id);
    const jobState = schedule.queueJobId ? await app.queue.getJobState(schedule.queueJobId) : null;
    return { ...schedule, jobState };
  });

  /** Cancels a schedule, but only while it has not started yet. */
  app.delete<{ Params: { id: string } }>("/schedules/:id", async (request, reply) => {
    const { userId } = currentUser(request);
    const schedule = await loadOwnedSchedule(app, userId, request.params.id);

    if (schedule.status !== "scheduled") {
      return reply
        .code(409)
        .send({ error: `Cannot cancel a schedule in state '${schedule.status}'` });
    }

    if (schedule.queueJobId) {
      const removed = await app.queue.cancel(schedule.queueJobId);
      if (!removed) {
        return reply.code(409).send({ error: "The scheduled job already started" });
      }
    }

    const updated = await app.prisma.schedule.update({
      where: { id: schedule.id },
      data: { status: "cancelled" }
    });
    await app.prisma.execution.updateMany({
      where: { scheduleId: schedule.id, status: "queued" },
      data: { status: "cancelled", finishedAt: new Date() }
    });
    return updated;
  });
}
