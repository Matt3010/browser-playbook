import type { FastifyInstance } from "fastify";
import type { Workflow } from "@app/database";

export class NotFoundError extends Error {
  constructor(message = "Not found") {
    super(message);
  }
}

/**
 * Loads a workflow only if it belongs to the given user. A workflow owned by
 * somebody else is reported as missing, never as forbidden, so the API does not
 * leak the existence of other users' resources.
 */
export async function loadOwnedWorkflow(
  app: FastifyInstance,
  userId: string,
  workflowId: string
): Promise<Workflow> {
  const workflow = await app.prisma.workflow.findFirst({ where: { id: workflowId, userId } });
  if (!workflow) throw new NotFoundError("Workflow not found");
  return workflow;
}

export async function loadOwnedExecution(app: FastifyInstance, userId: string, executionId: string) {
  const execution = await app.prisma.execution.findFirst({
    where: { id: executionId, workflow: { userId } },
    include: { workflow: { select: { id: true, name: true, userId: true } } }
  });
  if (!execution) throw new NotFoundError("Execution not found");
  return execution;
}

export async function loadOwnedSchedule(app: FastifyInstance, userId: string, scheduleId: string) {
  const schedule = await app.prisma.schedule.findFirst({
    where: { id: scheduleId, workflow: { userId } }
  });
  if (!schedule) throw new NotFoundError("Schedule not found");
  return schedule;
}
