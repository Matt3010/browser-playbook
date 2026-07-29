import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NotificationService } from "@app/database";
import {
  createTestContext,
  destroyTestContext,
  resetDatabase,
  registerUser,
  createWorkflow,
  gotoStep,
  clickStep,
  stepId,
  type TestContext,
  type AuthedUser
} from "./helpers";

let ctx: TestContext;
let user: AuthedUser;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  user = await registerUser(ctx.app, "owner@example.com");
});

async function readyWorkflow(name = "Runnable") {
  const workflow = await createWorkflow(ctx.app, user.cookie, name);
  await ctx.app.inject({
    method: "PUT",
    url: `/api/workflows/${workflow.id}/steps`,
    headers: { cookie: user.cookie },
    payload: { steps: [gotoStep("http://test-web:3001/login"), clickStep("Login")] }
  });
  return workflow;
}

describe("refusing to run a workflow that is already running", () => {
  // This product acts on real sites: a workflow that places an order must not be
  // able to place it twice because the run button was clicked twice, or because a
  // schedule came due while a manual run was still in flight. It is the same harm
  // maxStalledCount: 0 exists to prevent, arriving through a different door.
  it("refuses a second run while the first is still queued", async () => {
    const workflow = await readyWorkflow();
    const first = await ctx.app.inject({
      method: "POST",
      url: `/api/workflows/${workflow.id}/executions`,
      headers: { cookie: user.cookie }
    });
    expect(first.statusCode).toBe(202);

    const second = await ctx.app.inject({
      method: "POST",
      url: `/api/workflows/${workflow.id}/executions`,
      headers: { cookie: user.cookie }
    });
    expect(second.statusCode).toBe(409);
    expect(second.json<{ error: string }>().error).toMatch(/already/i);

    const rows = await ctx.prisma.execution.findMany({ where: { workflowId: workflow.id } });
    expect(rows).toHaveLength(1);
  });

  it("refuses a run while an execution is on the page", async () => {
    const workflow = await readyWorkflow();
    for (const status of ["starting", "running"]) {
      await ctx.prisma.execution.deleteMany({ where: { workflowId: workflow.id } });
      await ctx.prisma.execution.create({ data: { workflowId: workflow.id, status } });
      const response = await ctx.app.inject({
        method: "POST",
        url: `/api/workflows/${workflow.id}/executions`,
        headers: { cookie: user.cookie }
      });
      expect(response.statusCode, `status ${status} must block a new run`).toBe(409);
    }
  });

  it("lets a finished run be repeated", async () => {
    const workflow = await readyWorkflow();
    for (const status of ["completed", "failed", "cancelled"]) {
      await ctx.prisma.execution.deleteMany({ where: { workflowId: workflow.id } });
      await ctx.prisma.execution.create({
        data: { workflowId: workflow.id, status, finishedAt: new Date() }
      });
      const response = await ctx.app.inject({
        method: "POST",
        url: `/api/workflows/${workflow.id}/executions`,
        headers: { cookie: user.cookie }
      });
      expect(response.statusCode, `status ${status} must not block a new run`).toBe(202);
    }
  });

  it("does not treat tomorrow's schedule as a run in progress", async () => {
    // A scheduled run reserves its execution row the moment the schedule is
    // created. Reading that as "already running" would make a workflow with a
    // schedule impossible to run by hand until the schedule fired.
    const workflow = await readyWorkflow();
    const schedule = await ctx.prisma.schedule.create({
      data: {
        workflowId: workflow.id,
        runAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        timezone: "Europe/Rome",
        status: "scheduled"
      }
    });
    await ctx.prisma.execution.create({
      data: { workflowId: workflow.id, scheduleId: schedule.id, status: "queued" }
    });

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/workflows/${workflow.id}/executions`,
      headers: { cookie: user.cookie }
    });
    expect(response.statusCode).toBe(202);
  });

  it("keeps another workflow runnable", async () => {
    const busy = await readyWorkflow("Busy");
    const other = await readyWorkflow("Other");
    await ctx.prisma.execution.create({ data: { workflowId: busy.id, status: "running" } });

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/workflows/${other.id}/executions`,
      headers: { cookie: user.cookie }
    });
    expect(response.statusCode).toBe(202);
  });
});

describe("immediate execution and the BullMQ queue", () => {
  it("creates a queued execution and persists the job in Redis", async () => {
    const workflow = await readyWorkflow();
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/workflows/${workflow.id}/executions`,
      headers: { cookie: user.cookie }
    });
    expect(response.statusCode).toBe(202);
    const execution = response.json<{ id: string; status: string }>();
    expect(execution.status).toBe("queued");

    const stored = await ctx.prisma.execution.findUnique({ where: { id: execution.id } });
    expect(stored).not.toBeNull();
    expect(stored!.workflowId).toBe(workflow.id);

    // The job id equals the execution id, so it is addressable for cancellation.
    const state = await ctx.queue.getJobState(execution.id);
    expect(state).not.toBeNull();
    expect(["waiting", "delayed", "active", "prioritized"]).toContain(state);
  });

  it("refuses to run a workflow with no enabled steps", async () => {
    const workflow = await createWorkflow(ctx.app, user.cookie, "Empty");
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/workflows/${workflow.id}/executions`,
      headers: { cookie: user.cookie }
    });
    expect(response.statusCode).toBe(409);
    expect(await ctx.prisma.execution.count()).toBe(0);
  });

  it("refuses to run a disabled workflow", async () => {
    const workflow = await readyWorkflow();
    await ctx.app.inject({
      method: "PATCH",
      url: `/api/workflows/${workflow.id}`,
      headers: { cookie: user.cookie },
      payload: { status: "disabled" }
    });
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/workflows/${workflow.id}/executions`,
      headers: { cookie: user.cookie }
    });
    expect(response.statusCode).toBe(409);
  });

  it("does not let a user run another user's workflow", async () => {
    const workflow = await readyWorkflow();
    const other = await registerUser(ctx.app, "other@example.com");
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/workflows/${workflow.id}/executions`,
      headers: { cookie: other.cookie }
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("execution reads", () => {
  it("lists executions filtered by workflow and scoped to the user", async () => {
    const workflow = await readyWorkflow();
    await ctx.app.inject({
      method: "POST",
      url: `/api/workflows/${workflow.id}/executions`,
      headers: { cookie: user.cookie }
    });

    const list = await ctx.app.inject({
      method: "GET",
      url: `/api/executions?workflowId=${workflow.id}`,
      headers: { cookie: user.cookie }
    });
    expect(list.json()).toHaveLength(1);

    const other = await registerUser(ctx.app, "other@example.com");
    const otherList = await ctx.app.inject({
      method: "GET",
      url: "/api/executions",
      headers: { cookie: other.cookie }
    });
    expect(otherList.json()).toHaveLength(0);
  });

  it("returns an execution with logs, artifacts and duration", async () => {
    const workflow = await readyWorkflow();
    const startedAt = new Date("2026-07-26T10:00:00.000Z");
    const finishedAt = new Date("2026-07-26T10:00:12.500Z");
    const execution = await ctx.prisma.execution.create({
      data: {
        workflowId: workflow.id,
        status: "completed",
        startedAt,
        finishedAt,
        currentUrl: "http://test-web:3001/wizard/complete"
      }
    });
    await ctx.prisma.executionLog.create({
      data: { executionId: execution.id, level: "info", message: "step 1 ok" }
    });
    await ctx.prisma.artifact.create({
      data: { executionId: execution.id, type: "screenshot", path: "/data/artifacts/x.png" }
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/executions/${execution.id}`,
      headers: { cookie: user.cookie }
    });
    const body = response.json();
    expect(body.durationMs).toBe(12500);
    expect(body.logs).toHaveLength(1);
    expect(body.artifacts).toHaveLength(1);
    expect(body.currentUrl).toBe("http://test-web:3001/wizard/complete");
  });

  it("hides another user's execution", async () => {
    const workflow = await readyWorkflow();
    const execution = await ctx.prisma.execution.create({
      data: { workflowId: workflow.id, status: "queued" }
    });
    const other = await registerUser(ctx.app, "other@example.com");
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/executions/${execution.id}`,
      headers: { cookie: other.cookie }
    });
    expect(response.statusCode).toBe(404);
  });

  it("refuses to serve an artifact stored outside the artifact directory", async () => {
    const workflow = await readyWorkflow();
    const execution = await ctx.prisma.execution.create({
      data: { workflowId: workflow.id, status: "failed" }
    });
    const artifact = await ctx.prisma.artifact.create({
      data: { executionId: execution.id, type: "screenshot", path: "/etc/passwd" }
    });
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/artifacts/${artifact.id}/file`,
      headers: { cookie: user.cookie }
    });
    expect(response.statusCode).toBe(400);
  });

  it("hides another user's artifact", async () => {
    const workflow = await readyWorkflow();
    const execution = await ctx.prisma.execution.create({
      data: { workflowId: workflow.id, status: "failed" }
    });
    const artifact = await ctx.prisma.artifact.create({
      data: { executionId: execution.id, type: "screenshot", path: "/data/artifacts/a.png" }
    });
    const other = await registerUser(ctx.app, "other@example.com");
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/artifacts/${artifact.id}/file`,
      headers: { cookie: other.cookie }
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("internal notifications", () => {
  it("persists a notification through the service and exposes it via the API", async () => {
    const service = new NotificationService(ctx.prisma);
    await service.notify({
      userId: user.id,
      type: "workflow_completed",
      title: "Workflow completato",
      message: "Il workflow Runnable è terminato con successo"
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/notifications",
      headers: { cookie: user.cookie }
    });
    const body = response.json<{ items: Array<{ id: string; type: string }>; unread: number }>();
    expect(body.unread).toBe(1);
    expect(body.items[0].type).toBe("workflow_completed");
  });

  it("marks one notification and then all as read", async () => {
    const service = new NotificationService(ctx.prisma);
    await service.notify({
      userId: user.id,
      type: "workflow_failed",
      title: "Workflow fallito",
      message: "Selector non trovato"
    });
    await service.notify({
      userId: user.id,
      type: "schedule_started",
      title: "Esecuzione pianificata avviata",
      message: "Avvio"
    });

    const list = await ctx.app.inject({
      method: "GET",
      url: "/api/notifications",
      headers: { cookie: user.cookie }
    });
    const first = list.json().items[0].id;

    const read = await ctx.app.inject({
      method: "POST",
      url: `/api/notifications/${first}/read`,
      headers: { cookie: user.cookie }
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().readAt).not.toBeNull();

    const readAll = await ctx.app.inject({
      method: "POST",
      url: "/api/notifications/read-all",
      headers: { cookie: user.cookie }
    });
    expect(readAll.json().updated).toBe(1);

    const after = await ctx.app.inject({
      method: "GET",
      url: "/api/notifications",
      headers: { cookie: user.cookie }
    });
    expect(after.json().unread).toBe(0);
  });

  it("isolates notifications between users", async () => {
    const service = new NotificationService(ctx.prisma);
    await service.notify({
      userId: user.id,
      type: "workflow_completed",
      title: "Mine",
      message: "Mine"
    });
    const other = await registerUser(ctx.app, "other@example.com");
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/notifications",
      headers: { cookie: other.cookie }
    });
    expect(response.json().items).toHaveLength(0);
  });

  it("keeps a failing provider from breaking the notification flow", async () => {
    const errors: unknown[] = [];
    const service = new NotificationService(ctx.prisma, [
      {
        name: "broken",
        send: async () => {
          throw new Error("provider down");
        }
      }
    ]);
    await service.notify(
      { userId: user.id, type: "workflow_completed", title: "T", message: "M" },
      (err) => errors.push(err)
    );
    expect(errors).toHaveLength(1);
    // The in-app provider still stored the notification.
    expect(await ctx.prisma.notification.count()).toBe(1);
  });
});

describe("a failed enqueue must not leave a phantom execution", () => {
  it("marks the execution failed and reports 503 when the queue rejects the job", async () => {
    const workflow = await readyWorkflow("Queue down");

    // Simulate Redis being unavailable at the moment the job is enqueued.
    const original = ctx.queue.enqueueNow;
    ctx.queue.enqueueNow = async () => {
      throw new Error("Redis connection lost");
    };

    try {
      const response = await ctx.app.inject({
        method: "POST",
        url: `/api/workflows/${workflow.id}/executions`,
        headers: { cookie: user.cookie }
      });

      // The caller must learn the run did not start.
      expect(response.statusCode).toBe(503);

      // No execution may be left sitting in `queued`: it would never run and
      // never fail, showing up forever as pending in the UI.
      const stuck = await ctx.prisma.execution.findMany({
        where: { workflowId: workflow.id, status: "queued" }
      });
      expect(stuck, "no execution may stay queued after a failed enqueue").toHaveLength(0);

      const failed = await ctx.prisma.execution.findMany({
        where: { workflowId: workflow.id }
      });
      expect(failed).toHaveLength(1);
      expect(failed[0].status).toBe("failed");
      expect(failed[0].errorMessage).toMatch(/enqueue/i);
      expect(failed[0].finishedAt).not.toBeNull();
    } finally {
      ctx.queue.enqueueNow = original;
    }
  });
});

describe("references to values that do not exist", () => {
  async function workflowUsing(template: string) {
    const workflow = await createWorkflow(ctx.app, user.cookie, `Uses ${template}`);
    await ctx.app.inject({
      method: "PUT",
      url: `/api/workflows/${workflow.id}/steps`,
      headers: { cookie: user.cookie },
      payload: {
        steps: [
          gotoStep("http://test-web:3001/login"),
          {
            id: `00000000-0000-4000-8000-${String(Date.now()).slice(-12)}`,
            type: "fill",
            name: "Inserisci Password",
            pageId: "main",
            selector: {
              strategy: "label",
              value: "Password",
              fallback: null,
              pageId: "main",
              frame: null
            },
            value: template,
            timeoutMs: 10000,
            enabled: true
          }
        ]
      }
    });
    return workflow;
  }

  it("refuses an immediate run instead of failing halfway through it", async () => {
    const workflow = await workflowUsing("{{credentials.password}}");
    // Saving the steps creates the name, empty. This is the other case: the
    // value existed and was deleted afterwards, which is what a run days later
    // walks into.
    await ctx.prisma.credential.deleteMany({ where: { name: "password" } });

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/workflows/${workflow.id}/executions`,
      headers: { cookie: user.cookie }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("credentials.password");
    expect(response.json().missingReferences[0]).toMatchObject({
      kind: "credentials",
      name: "password"
    });
    // Nothing was queued, so no browser is started for a run that cannot work.
    expect(await ctx.prisma.execution.count()).toBe(0);
  });

  it("refuses to schedule a run that could not succeed", async () => {
    const workflow = await workflowUsing("{{credentials.password}}");
    await ctx.prisma.credential.deleteMany({ where: { name: "password" } });

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/workflows/${workflow.id}/schedules`,
      headers: { cookie: user.cookie },
      payload: {
        runAt: new Date(Date.now() + 60_000).toISOString(),
        timezone: "Europe/Rome"
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("credentials.password");
    expect(await ctx.prisma.schedule.count()).toBe(0);
    expect(await ctx.prisma.execution.count()).toBe(0);
  });

  it("accepts the run once the credential exists", async () => {
    const workflow = await workflowUsing("{{credentials.password}}");

    await ctx.app.inject({
      method: "POST",
      url: "/api/credentials",
      headers: { cookie: user.cookie },
      payload: { name: "password", value: "TestPassword123!", kind: "secret" }
    });

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/workflows/${workflow.id}/executions`,
      headers: { cookie: user.cookie }
    });
    expect(response.statusCode).toBe(202);
  });

  it("creates every value the saved steps refer to, empty", async () => {
    // A reference typed into the editor used to name nothing at all: the
    // workflow saved happily and the run was refused later, with nowhere
    // obvious to go and fill the value in.
    await workflowUsing("{{variables.repoName}}");

    const listed = await ctx.app.inject({
      method: "GET",
      url: "/api/credentials",
      headers: { cookie: user.cookie }
    });
    const created = listed
      .json()
      .find((row: { name: string }) => row.name === "repoName");
    expect(created, "the reference must have been created").toBeTruthy();
    expect(created).toMatchObject({ kind: "variable", value: "", hasValue: false });
  });

  it("makes a secret out of a credentials reference and a variable out of a variables one", async () => {
    await workflowUsing("{{credentials.apiToken}}");

    const listed = await ctx.app.inject({
      method: "GET",
      url: "/api/credentials",
      headers: { cookie: user.cookie }
    });
    const created = listed.json().find((row: { name: string }) => row.name === "apiToken");
    expect(created).toMatchObject({ kind: "secret", value: null, hasValue: false });
  });

  it("refuses a run whose reference exists but holds nothing", async () => {
    // Existing stopped being proof that there is anything to type. An empty
    // secret sent to a login form is a failed attempt against the real site.
    const workflow = await workflowUsing("{{credentials.password}}");

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/workflows/${workflow.id}/executions`,
      headers: { cookie: user.cookie }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("is empty");
    expect(response.json().error).toContain("credentials.password");
    expect(await ctx.prisma.execution.count()).toBe(0);
  });

  it("refuses to schedule a run whose reference holds nothing", async () => {
    const workflow = await workflowUsing("{{credentials.password}}");

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/workflows/${workflow.id}/schedules`,
      headers: { cookie: user.cookie },
      payload: {
        runAt: new Date(Date.now() + 60_000).toISOString(),
        timezone: "Europe/Rome"
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("is empty");
    expect(await ctx.prisma.schedule.count()).toBe(0);
  });

  it("does not accept a variable in place of a credential", async () => {
    const workflow = await workflowUsing("{{credentials.password}}");

    // Same name, wrong namespace.
    await ctx.app.inject({
      method: "POST",
      url: "/api/credentials",
      headers: { cookie: user.cookie },
      payload: { name: "password", value: "plain", kind: "variable" }
    });

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/workflows/${workflow.id}/executions`,
      headers: { cookie: user.cookie }
    });
    expect(response.statusCode).toBe(409);
  });
});

describe("cancelling an execution", () => {
  it("cancels a queued execution and removes its job from the queue", async () => {
    const workflow = await readyWorkflow("Cancellabile");
    const started = (
      await ctx.app.inject({
        method: "POST",
        url: `/api/workflows/${workflow.id}/executions`,
        headers: { cookie: user.cookie }
      })
    ).json<{ id: string }>();

    expect(await ctx.queue.getJobState(started.id)).not.toBeNull();

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/executions/${started.id}/cancel`,
      headers: { cookie: user.cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("cancelled");

    // The job is gone, so it can never start later.
    expect(await ctx.queue.getJobState(started.id)).toBeNull();

    const stored = await ctx.prisma.execution.findUnique({ where: { id: started.id } });
    expect(stored!.status).toBe("cancelled");
    expect(stored!.finishedAt).not.toBeNull();
  });

  it("cancels a running execution and closes its browser session", async () => {
    const workflow = await readyWorkflow("In corso");
    const execution = await ctx.prisma.execution.create({
      data: { workflowId: workflow.id, status: "running", startedAt: new Date() }
    });
    // The runner names the session after the execution.
    await ctx.worker.createSession({
      sessionId: execution.id,
      userId: user.id,
      startUrl: "http://test-web:3001/login",
      timeoutMs: 60_000
    });

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/executions/${execution.id}/cancel`,
      headers: { cookie: user.cookie }
    });
    expect(response.statusCode).toBe(200);

    const stored = await ctx.prisma.execution.findUnique({ where: { id: execution.id } });
    expect(stored!.status).toBe("cancelled");

    // The browser must be released, not left holding a slot until it times out.
    expect(ctx.worker.sessions.get(execution.id)!.state).toBe("closed");
  });

  it("refuses to cancel an execution that already finished", async () => {
    const workflow = await readyWorkflow("Finita");
    for (const status of ["completed", "failed", "cancelled"] as const) {
      const execution = await ctx.prisma.execution.create({
        data: { workflowId: workflow.id, status, finishedAt: new Date() }
      });
      const response = await ctx.app.inject({
        method: "POST",
        url: `/api/executions/${execution.id}/cancel`,
        headers: { cookie: user.cookie }
      });
      expect(response.statusCode, status).toBe(409);
    }
  });

  it("does not let a user cancel another user's execution", async () => {
    const workflow = await readyWorkflow("Altrui");
    const execution = await ctx.prisma.execution.create({
      data: { workflowId: workflow.id, status: "running", startedAt: new Date() }
    });
    const other = await registerUser(ctx.app, "other@example.com");

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/executions/${execution.id}/cancel`,
      headers: { cookie: other.cookie },
      payload: {}
    });
    expect(response.statusCode).toBe(404);
    const stored = await ctx.prisma.execution.findUnique({ where: { id: execution.id } });
    expect(stored!.status).toBe("running");
  });

  it("records why the execution stopped", async () => {
    const workflow = await readyWorkflow("Con log");
    const execution = await ctx.prisma.execution.create({
      data: { workflowId: workflow.id, status: "running", startedAt: new Date() }
    });

    await ctx.app.inject({
      method: "POST",
      url: `/api/executions/${execution.id}/cancel`,
      headers: { cookie: user.cookie }
    });

    const logs = await ctx.prisma.executionLog.findMany({
      where: { executionId: execution.id }
    });
    expect(logs.some((l) => /cancelled/i.test(l.message))).toBe(true);
  });
});

describe("what a run read from the page", () => {
  it("returns the values a run recorded, in the order it read them", async () => {
    const workflow = await readyWorkflow();
    const execution = await ctx.prisma.execution.create({
      data: { workflowId: workflow.id, status: "completed" }
    });
    await ctx.prisma.executionOutput.create({
      data: {
        executionId: execution.id,
        name: "saldo",
        raw: "€ 1.234,56",
        kind: "number",
        number: 1234.56
      }
    });
    await ctx.prisma.executionOutput.create({
      data: {
        executionId: execution.id,
        name: "accettato",
        raw: "true",
        kind: "boolean",
        boolean: true
      }
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/executions/${execution.id}`,
      headers: { cookie: user.cookie }
    });

    expect(response.statusCode).toBe(200);
    const outputs = response.json().outputs;
    expect(outputs).toHaveLength(2);
    expect(outputs[0]).toMatchObject({ name: "saldo", raw: "€ 1.234,56", kind: "number" });
    expect(outputs[1]).toMatchObject({ name: "accettato", kind: "boolean", boolean: true });
  });

  it("says nothing at all when a run read nothing", async () => {
    const workflow = await readyWorkflow();
    const execution = await ctx.prisma.execution.create({
      data: { workflowId: workflow.id, status: "completed" }
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/executions/${execution.id}`,
      headers: { cookie: user.cookie }
    });
    expect(response.json().outputs).toEqual([]);
  });

  it("refuses to save a read step that names nothing", async () => {
    const workflow = await createWorkflow(ctx.app, user.cookie, "Legge senza nome");
    const response = await ctx.app.inject({
      method: "PUT",
      url: `/api/workflows/${workflow.id}/steps`,
      headers: { cookie: user.cookie },
      payload: {
        steps: [
          gotoStep("http://test-web:3001/elements"),
          {
            id: stepId(),
            type: "read",
            name: "Leggi il saldo",
            pageId: "main",
            selector: { strategy: "id", value: "saldo", fallback: null, pageId: "main", frame: null },
            value: null,
            timeoutMs: 10000,
            enabled: true
          }
        ]
      }
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).toMatch(/output name/i);
  });

  it("refuses two live reads filing under one name", async () => {
    const workflow = await createWorkflow(ctx.app, user.cookie, "Due letture uguali");
    const read = (outputName: string) => ({
      id: stepId(),
      type: "read",
      name: `Leggi ${outputName}`,
      pageId: "main",
      selector: { strategy: "id", value: "saldo", fallback: null, pageId: "main", frame: null },
      value: null,
      outputName,
      timeoutMs: 10000,
      enabled: true
    });

    const response = await ctx.app.inject({
      method: "PUT",
      url: `/api/workflows/${workflow.id}/steps`,
      headers: { cookie: user.cookie },
      payload: { steps: [gotoStep("http://test-web:3001/elements"), read("saldo"), read("saldo")] }
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).toMatch(/saldo/);
  });

  it("keeps the output name through save and read back", async () => {
    // A new field crosses several hand-written row mappings; if one drops it,
    // it vanishes silently on that path alone.
    const workflow = await createWorkflow(ctx.app, user.cookie, "Legge il saldo");
    const saved = await ctx.app.inject({
      method: "PUT",
      url: `/api/workflows/${workflow.id}/steps`,
      headers: { cookie: user.cookie },
      payload: {
        steps: [
          gotoStep("http://test-web:3001/elements"),
          {
            id: stepId(),
            type: "read",
            name: "Leggi il saldo",
            pageId: "main",
            selector: { strategy: "id", value: "saldo", fallback: null, pageId: "main", frame: null },
            value: null,
            outputName: "saldo",
            timeoutMs: 10000,
            enabled: true
          }
        ]
      }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()[1].outputName).toBe("saldo");

    const reread = await ctx.app.inject({
      method: "GET",
      url: `/api/workflows/${workflow.id}`,
      headers: { cookie: user.cookie }
    });
    expect(reread.json().steps[1].outputName).toBe("saldo");
  });
});
