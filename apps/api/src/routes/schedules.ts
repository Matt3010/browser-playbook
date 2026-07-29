import type { FastifyInstance } from "fastify";
import {
  isRecurringInput,
  isRunnableStepList,
  stepFromRow,
  validateRecurringSchedule,
  validateSchedule
} from "@app/workflow-schema";
import { requireAuth, currentUser } from "../auth";
import { loadOwnedWorkflow, loadOwnedSchedule } from "../ownership";
import { referenceState, unresolvedReferences } from "../references";

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

    // Two shapes, one endpoint: an instant, or a recurrence. Which one is asked
    // for decides everything downstream, so it is decided once, here.
    const recurring = isRecurringInput(request.body);
    const validation = recurring
      ? validateRecurringSchedule(request.body)
      : validateSchedule(request.body);
    if (!validation.valid) {
      return reply.code(400).send({ error: "Invalid schedule", details: validation.errors });
    }

    const stepRows = await app.prisma.workflowStep.findMany({
      where: { workflowId: workflow.id },
      orderBy: { position: "asc" }
    });
    const steps = stepRows.map(stepFromRow);
    if (!isRunnableStepList(steps)) {
      return reply.code(409).send({ error: "Workflow has no enabled steps to run" });
    }

    // Nobody is watching a scheduled run, so a missing reference must be caught
    // now rather than at three in the morning.
    const unresolved = unresolvedReferences(steps, await referenceState(app, userId));
    if (unresolved) {
      return reply.code(409).send(unresolved);
    }

    if (recurring) {
      const { cron, timezone } = validation as { cron: string; timezone: string };
      const schedule = await app.prisma.schedule.create({
        data: { workflowId: workflow.id, cron, timezone, runAt: null, status: "scheduled" }
      });
      try {
        // No execution row is reserved: a recurrence has no single run, and each
        // occurrence creates its own when the queue fires it.
        await app.queue.upsertRecurring(schedule.id, cron, timezone, {
          workflowId: workflow.id,
          userId,
          scheduleId: schedule.id
        });
        const updated = await app.prisma.schedule.update({
          where: { id: schedule.id },
          data: { queueJobId: schedule.id }
        });
        return reply.code(201).send({ ...updated, nextRunAt: await app.queue.nextRunOf(schedule.id) });
      } catch (err) {
        // Never leave a schedule that says it repeats when nothing repeats it.
        await app.prisma.schedule.update({
          where: { id: schedule.id },
          data: { status: "failed" }
        });
        app.log.error({ err }, "Failed to register the recurring schedule");
        return reply.code(503).send({ error: "Could not register the recurring schedule" });
      }
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
        (validation as { delayMs: number }).delayMs
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

  /**
   * What is due next, across every workflow of this user.
   *
   * A schedule is easy to lose sight of: it lives on the page of the workflow it
   * belongs to, and by the time there are a few of them nobody remembers what is
   * about to happen tonight. When a recurring schedule is next due is not in the
   * database at all — the queue holds the recurrence — so it is asked for here.
   */
  app.get("/schedules/upcoming", async (request) => {
    const { userId } = currentUser(request);
    const schedules = await app.prisma.schedule.findMany({
      where: { status: "scheduled", workflow: { userId } },
      include: { workflow: { select: { id: true, name: true } } }
    });

    const entries = await Promise.all(
      schedules.map(async (schedule) => ({
        id: schedule.id,
        workflowId: schedule.workflow.id,
        workflowName: schedule.workflow.name,
        cron: schedule.cron,
        timezone: schedule.timezone,
        at: schedule.cron
          ? ((await app.queue.nextRunOf(schedule.id))?.toISOString() ?? null)
          : (schedule.runAt?.toISOString() ?? null)
      }))
    );

    // Soonest first; one whose next run the queue could not tell us goes last
    // rather than pretending to be imminent.
    return entries.sort((a, b) => {
      if (a.at === b.at) return 0;
      if (!a.at) return 1;
      if (!b.at) return -1;
      return a.at < b.at ? -1 : 1;
    });
  });

  app.get<{ Params: { id: string } }>("/workflows/:id/schedules", async (request) => {
    const { userId } = currentUser(request);
    const workflow = await loadOwnedWorkflow(app, userId, request.params.id);
    return app.prisma.schedule.findMany({
      where: { workflowId: workflow.id },
      orderBy: { createdAt: "desc" },
      include: { executions: { select: { id: true, status: true } } }
    });
  });

  app.get<{ Params: { id: string } }>("/schedules/:id", async (request) => {
    const { userId } = currentUser(request);
    const schedule = await loadOwnedSchedule(app, userId, request.params.id);
    if (schedule.cron) {
      return { ...schedule, jobState: null, nextRunAt: await app.queue.nextRunOf(schedule.id) };
    }
    const jobState = schedule.queueJobId ? await app.queue.getJobState(schedule.queueJobId) : null;
    return { ...schedule, jobState, nextRunAt: schedule.runAt };
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

    if (schedule.cron) {
      // Removing the scheduler stops future occurrences; one already running is
      // an execution of its own and is left to finish.
      await app.queue.removeRecurring(schedule.id);
    } else if (schedule.queueJobId) {
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
