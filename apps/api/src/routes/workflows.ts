import { rm } from "fs/promises";
import path from "path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertSafeTargetUrl } from "@app/shared";
import { StepSchema, validateSteps, isRunnableStepList, type Step } from "@app/workflow-schema";
import { requireAuth, currentUser } from "../auth";
import { loadOwnedWorkflow } from "../ownership";

const CreateWorkflowSchema = z.object({
  name: z.string().min(1).max(200),
  startUrl: z.string().min(1).max(2000)
});

const UpdateWorkflowSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  startUrl: z.string().min(1).max(2000).optional(),
  status: z.enum(["draft", "ready", "disabled"]).optional()
});

const PutStepsSchema = z.object({
  steps: z.array(z.unknown())
});

/** Converts a DB row into the JSON step shape used by the API and the runner. */
function rowToStep(row: {
  id: string;
  type: string;
  name: string;
  pageId: string;
  pageOrigin: string | null;
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
    pageOrigin: row.pageOrigin,
    selector: row.selectorJson ?? null,
    value: row.valueTemplate,
    timeoutMs: row.timeoutMs,
    enabled: row.enabled,
    isFinal: row.isFinal
  });
}

export async function workflowRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  const urlSafetyOptions = {
    allowPrivateTargets: app.config.allowPrivateTargets,
    allowedHosts: app.config.allowedTargetHosts
  };

  app.get("/", async (request) => {
    const { userId } = currentUser(request);
    const workflows = await app.prisma.workflow.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      include: { _count: { select: { steps: true, executions: true } } }
    });
    return workflows.map((w) => ({
      id: w.id,
      name: w.name,
      startUrl: w.startUrl,
      status: w.status,
      stepCount: w._count.steps,
      executionCount: w._count.executions,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt
    }));
  });

  app.post("/", async (request, reply) => {
    const { userId } = currentUser(request);
    const parsed = CreateWorkflowSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "name and startUrl are required" });
    }
    try {
      assertSafeTargetUrl(parsed.data.startUrl, urlSafetyOptions);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    const workflow = await app.prisma.workflow.create({
      data: { userId, name: parsed.data.name, startUrl: parsed.data.startUrl, status: "draft" }
    });
    return reply.code(201).send(workflow);
  });

  app.get<{ Params: { id: string } }>("/:id", async (request) => {
    const { userId } = currentUser(request);
    const workflow = await loadOwnedWorkflow(app, userId, request.params.id);
    const steps = await app.prisma.workflowStep.findMany({
      where: { workflowId: workflow.id },
      orderBy: { position: "asc" }
    });
    return { ...workflow, steps: steps.map(rowToStep) };
  });

  app.patch<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const { userId } = currentUser(request);
    const workflow = await loadOwnedWorkflow(app, userId, request.params.id);
    const parsed = UpdateWorkflowSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid workflow payload" });
    }
    if (parsed.data.startUrl) {
      try {
        assertSafeTargetUrl(parsed.data.startUrl, urlSafetyOptions);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    }
    return app.prisma.workflow.update({ where: { id: workflow.id }, data: parsed.data });
  });

  app.delete<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const { userId } = currentUser(request);
    const workflow = await loadOwnedWorkflow(app, userId, request.params.id);

    // The database rows disappear with the cascade, but the screenshots and
    // downloaded files live on a volume and would stay there forever.
    const executions = await app.prisma.execution.findMany({
      where: { workflowId: workflow.id },
      select: { id: true }
    });

    await app.prisma.workflow.delete({ where: { id: workflow.id } });

    const root = path.resolve(app.config.artifactDir);
    for (const execution of executions) {
      const directory = path.resolve(root, execution.id);
      // Never step outside the artifact root, whatever the id looks like.
      if (directory !== path.join(root, execution.id)) continue;
      if (!directory.startsWith(root + path.sep)) continue;
      try {
        await rm(directory, { recursive: true, force: true, maxRetries: 2 });
      } catch (err) {
        // The workflow is already gone; a leftover directory is not worth failing on.
        request.log.warn({ err, directory }, "Could not remove an execution artifact directory");
      }
    }

    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>("/:id/steps", async (request) => {
    const { userId } = currentUser(request);
    const workflow = await loadOwnedWorkflow(app, userId, request.params.id);
    const steps = await app.prisma.workflowStep.findMany({
      where: { workflowId: workflow.id },
      orderBy: { position: "asc" }
    });
    return steps.map(rowToStep);
  });

  /**
   * Replaces the whole step list. The editor always sends the full ordered
   * list, which keeps reorder/delete/disable a single atomic operation.
   */
  app.put<{ Params: { id: string } }>("/:id/steps", async (request, reply) => {
    const { userId } = currentUser(request);
    const workflow = await loadOwnedWorkflow(app, userId, request.params.id);

    const body = PutStepsSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "steps must be an array" });
    }
    const validation = validateSteps(body.data.steps);
    if (!validation.valid) {
      return reply.code(400).send({ error: "Invalid steps", details: validation.errors });
    }
    const steps = (body.data.steps as unknown[]).map((s) => StepSchema.parse(s));

    const seen = new Set<string>();
    for (const step of steps) {
      if (seen.has(step.id)) {
        return reply.code(400).send({ error: `Duplicate step id: ${step.id}` });
      }
      seen.add(step.id);
    }

    await app.prisma.$transaction([
      app.prisma.workflowStep.deleteMany({ where: { workflowId: workflow.id } }),
      app.prisma.workflowStep.createMany({
        data: steps.map((step, index) => ({
          id: step.id,
          workflowId: workflow.id,
          position: index,
          type: step.type,
          name: step.name,
          pageId: step.pageId,
          pageOrigin: step.pageOrigin ?? null,
          selectorJson: (step.selector ?? null) as never,
          valueTemplate: step.value ?? null,
          timeoutMs: step.timeoutMs,
          enabled: step.enabled,
          isFinal: step.isFinal
        }))
      }),
      app.prisma.workflow.update({
        where: { id: workflow.id },
        data: { status: isRunnableStepList(steps) ? "ready" : "draft" }
      })
    ]);

    const saved = await app.prisma.workflowStep.findMany({
      where: { workflowId: workflow.id },
      orderBy: { position: "asc" }
    });
    return saved.map(rowToStep);
  });
}
