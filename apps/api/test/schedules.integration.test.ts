import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestContext,
  destroyTestContext,
  resetDatabase,
  registerUser,
  createWorkflow,
  gotoStep,
  clickStep,
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

async function readyWorkflow() {
  const workflow = await createWorkflow(ctx.app, user.cookie, "Scheduled flow");
  await ctx.app.inject({
    method: "PUT",
    url: `/api/workflows/${workflow.id}/steps`,
    headers: { cookie: user.cookie },
    payload: { steps: [gotoStep("http://test-web:3001/login"), clickStep("Login")] }
  });
  return workflow;
}

function inFuture(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

async function schedule(workflowId: string, runAt: string, timezone = "Europe/Rome") {
  return ctx.app.inject({
    method: "POST",
    url: `/api/workflows/${workflowId}/schedules`,
    headers: { cookie: user.cookie },
    payload: { runAt, timezone }
  });
}

describe("single future schedule", () => {
  it("creates the schedule, the queued execution and a delayed persistent job", async () => {
    const workflow = await readyWorkflow();
    const runAt = inFuture(60_000);
    const response = await schedule(workflow.id, runAt);

    expect(response.statusCode).toBe(201);
    const body = response.json<{
      id: string;
      status: string;
      queueJobId: string;
      timezone: string;
      executionId: string;
    }>();
    expect(body.status).toBe("scheduled");
    expect(body.timezone).toBe("Europe/Rome");
    expect(body.queueJobId).toBe(body.executionId);

    const execution = await ctx.prisma.execution.findUnique({ where: { id: body.executionId } });
    expect(execution!.status).toBe("queued");
    expect(execution!.scheduleId).toBe(body.id);

    // The job lives in Redis with a delay, so it survives a restart.
    expect(await ctx.queue.getJobState(body.queueJobId)).toBe("delayed");
  });

  it("stores runAt and timezone as given", async () => {
    const workflow = await readyWorkflow();
    const runAt = inFuture(120_000);
    const body = (await schedule(workflow.id, runAt, "UTC")).json();
    const stored = await ctx.prisma.schedule.findUnique({ where: { id: body.id } });
    expect(stored!.runAt.toISOString()).toBe(new Date(runAt).toISOString());
    expect(stored!.timezone).toBe("UTC");
  });

  it("rejects a past instant", async () => {
    const workflow = await readyWorkflow();
    const response = await schedule(workflow.id, new Date(Date.now() - 60_000).toISOString());
    expect(response.statusCode).toBe(400);
    expect(await ctx.prisma.schedule.count()).toBe(0);
    expect(await ctx.prisma.execution.count()).toBe(0);
  });

  it("rejects an invalid timezone", async () => {
    const workflow = await readyWorkflow();
    const response = await schedule(workflow.id, inFuture(60_000), "Mars/Olympus");
    expect(response.statusCode).toBe(400);
  });

  it("rejects a workflow with no enabled steps", async () => {
    const workflow = await createWorkflow(ctx.app, user.cookie, "Empty");
    const response = await schedule(workflow.id, inFuture(60_000));
    expect(response.statusCode).toBe(409);
  });

  it("does not let a user schedule another user's workflow", async () => {
    const workflow = await readyWorkflow();
    const other = await registerUser(ctx.app, "other@example.com");
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/workflows/${workflow.id}/schedules`,
      headers: { cookie: other.cookie },
      payload: { runAt: inFuture(60_000), timezone: "UTC" }
    });
    expect(response.statusCode).toBe(404);
  });

  it("lists the schedules of a workflow", async () => {
    const workflow = await readyWorkflow();
    await schedule(workflow.id, inFuture(60_000));
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/workflows/${workflow.id}/schedules`,
      headers: { cookie: user.cookie }
    });
    expect(response.json()).toHaveLength(1);
  });

  it("exposes the live queue state of a schedule", async () => {
    const workflow = await readyWorkflow();
    const created = (await schedule(workflow.id, inFuture(60_000))).json();
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/schedules/${created.id}`,
      headers: { cookie: user.cookie }
    });
    expect(response.json().jobState).toBe("delayed");
  });
});

describe("schedule cancellation", () => {
  it("cancels a pending schedule, removes the job and cancels the execution", async () => {
    const workflow = await readyWorkflow();
    const created = (await schedule(workflow.id, inFuture(60_000))).json();

    const response = await ctx.app.inject({
      method: "DELETE",
      url: `/api/schedules/${created.id}`,
      headers: { cookie: user.cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("cancelled");

    expect(await ctx.queue.getJobState(created.queueJobId)).toBeNull();
    const execution = await ctx.prisma.execution.findUnique({
      where: { id: created.executionId }
    });
    expect(execution!.status).toBe("cancelled");
    expect(execution!.finishedAt).not.toBeNull();
  });

  it("refuses to cancel twice", async () => {
    const workflow = await readyWorkflow();
    const created = (await schedule(workflow.id, inFuture(60_000))).json();
    await ctx.app.inject({
      method: "DELETE",
      url: `/api/schedules/${created.id}`,
      headers: { cookie: user.cookie }
    });
    const second = await ctx.app.inject({
      method: "DELETE",
      url: `/api/schedules/${created.id}`,
      headers: { cookie: user.cookie }
    });
    expect(second.statusCode).toBe(409);
  });

  it("does not let another user cancel a schedule", async () => {
    const workflow = await readyWorkflow();
    const created = (await schedule(workflow.id, inFuture(60_000))).json();
    const other = await registerUser(ctx.app, "other@example.com");
    const response = await ctx.app.inject({
      method: "DELETE",
      url: `/api/schedules/${created.id}`,
      headers: { cookie: other.cookie }
    });
    expect(response.statusCode).toBe(404);
    expect(await ctx.queue.getJobState(created.queueJobId)).toBe("delayed");
  });
});

describe("recurring schedules", () => {
  async function runnableWorkflow(name: string) {
    const workflow = await createWorkflow(ctx.app, user.cookie, name);
    await ctx.app.inject({
      method: "PUT",
      url: `/api/workflows/${workflow.id}/steps`,
      headers: { cookie: user.cookie },
      payload: { steps: [gotoStep("http://test-web:3001/elements")] }
    });
    return workflow;
  }

  async function schedule(workflowId: string, payload: unknown) {
    return ctx.app.inject({
      method: "POST",
      url: `/api/workflows/${workflowId}/schedules`,
      headers: { cookie: user.cookie },
      payload: payload as Record<string, unknown>
    });
  }

  it("registers a repeating job instead of reserving one execution", async () => {
    const workflow = await runnableWorkflow("Ogni mattina");

    const response = await schedule(workflow.id, {
      recurrence: { kind: "days", every: 1, time: "03:00" },
      timezone: "Europe/Rome"
    });

    expect(response.statusCode).toBe(201);
    const created = response.json();
    expect(created.cron).toBe("0 3 * * *");
    expect(created.runAt).toBeNull();
    expect(created.nextRunAt, "the queue knows when it is due next").toBeTruthy();

    // A recurrence has no single run, so nothing is reserved for it.
    expect(await ctx.prisma.execution.count({ where: { workflowId: workflow.id } })).toBe(0);

    const stored = await ctx.prisma.schedule.findUnique({ where: { id: created.id } });
    expect(stored).toMatchObject({ cron: "0 3 * * *", timezone: "Europe/Rome", status: "scheduled" });
  });

  it("refuses a recurrence that is not one", async () => {
    const workflow = await runnableWorkflow("Ricorrenza sbagliata");

    const response = await schedule(workflow.id, {
      recurrence: { kind: "days", every: 1, time: "25:00" },
      timezone: "Europe/Rome"
    });

    expect(response.statusCode).toBe(400);
    expect(await ctx.prisma.schedule.count({ where: { workflowId: workflow.id } })).toBe(0);
  });

  it("checks the same things a one-shot schedule checks", async () => {
    // Nobody is watching at three in the morning, every morning.
    const workflow = await createWorkflow(ctx.app, user.cookie, "Senza step");
    const response = await schedule(workflow.id, {
      recurrence: { kind: "days", every: 1, time: "03:00" },
      timezone: "Europe/Rome"
    });
    expect(response.statusCode).toBe(409);
  });

  it("stops repeating when it is cancelled", async () => {
    const workflow = await runnableWorkflow("Da fermare");
    const created = (
      await schedule(workflow.id, {
        recurrence: { kind: "weekly", weekday: 1, time: "07:30" },
        timezone: "Europe/Rome"
      })
    ).json();
    expect(await ctx.queue.nextRunOf(created.id)).toBeTruthy();

    const cancelled = await ctx.app.inject({
      method: "DELETE",
      url: `/api/schedules/${created.id}`,
      headers: { cookie: user.cookie }
    });

    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe("cancelled");
    expect(await ctx.queue.nextRunOf(created.id), "nothing may fire it again").toBeNull();
  });

  it("moves the recurrence instead of leaving two behind", async () => {
    const workflow = await runnableWorkflow("Cambio orario");
    const first = (
      await schedule(workflow.id, {
        recurrence: { kind: "days", every: 1, time: "03:00" },
        timezone: "Europe/Rome"
      })
    ).json();
    const second = (
      await schedule(workflow.id, {
        recurrence: { kind: "days", every: 1, time: "05:00" },
        timezone: "Europe/Rome"
      })
    ).json();

    expect(second.id).not.toBe(first.id);
    // Each schedule is its own repeating job, keyed by its own id.
    expect(await ctx.queue.nextRunOf(first.id)).toBeTruthy();
    expect(await ctx.queue.nextRunOf(second.id)).toBeTruthy();
  });
});

describe("what is coming next", () => {
  async function runnable(name: string) {
    const workflow = await createWorkflow(ctx.app, user.cookie, name);
    await ctx.app.inject({
      method: "PUT",
      url: `/api/workflows/${workflow.id}/steps`,
      headers: { cookie: user.cookie },
      payload: { steps: [gotoStep("http://test-web:3001/elements")] }
    });
    return workflow;
  }

  async function upcoming() {
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/schedules/upcoming",
      headers: { cookie: user.cookie }
    });
    expect(response.statusCode).toBe(200);
    return response.json() as Array<{
      workflowName: string;
      at: string | null;
      cron: string | null;
    }>;
  }

  it("lists what is due, soonest first, whichever workflow it belongs to", async () => {
    const later = await runnable("Fra due ore");
    const sooner = await runnable("Fra un'ora");

    await ctx.app.inject({
      method: "POST",
      url: `/api/workflows/${later.id}/schedules`,
      headers: { cookie: user.cookie },
      payload: {
        runAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
        timezone: "Europe/Rome"
      }
    });
    await ctx.app.inject({
      method: "POST",
      url: `/api/workflows/${sooner.id}/schedules`,
      headers: { cookie: user.cookie },
      payload: {
        runAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        timezone: "Europe/Rome"
      }
    });

    const list = await upcoming();
    expect(list.map((entry) => entry.workflowName)).toEqual(["Fra un'ora", "Fra due ore"]);
  });

  it("says when a recurring schedule is due next, which only the queue knows", async () => {
    const workflow = await runnable("Ogni quarto d'ora");
    await ctx.app.inject({
      method: "POST",
      url: `/api/workflows/${workflow.id}/schedules`,
      headers: { cookie: user.cookie },
      payload: { recurrence: { kind: "minutes", every: 15 }, timezone: "Europe/Rome" }
    });

    const list = await upcoming();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ workflowName: "Ogni quarto d'ora", cron: "*/15 * * * *" });
    expect(new Date(list[0].at as string).getTime()).toBeGreaterThan(Date.now());
  });

  it("forgets a schedule once it has been cancelled", async () => {
    const workflow = await runnable("Poi annullata");
    const created = (
      await ctx.app.inject({
        method: "POST",
        url: `/api/workflows/${workflow.id}/schedules`,
        headers: { cookie: user.cookie },
        payload: { recurrence: { kind: "days", every: 1, time: "03:00" }, timezone: "Europe/Rome" }
      })
    ).json();

    expect(await upcoming()).toHaveLength(1);
    await ctx.app.inject({
      method: "DELETE",
      url: `/api/schedules/${created.id}`,
      headers: { cookie: user.cookie }
    });
    expect(await upcoming()).toHaveLength(0);
  });

  it("never shows another user what is coming for them", async () => {
    const workflow = await runnable("Mia");
    await ctx.app.inject({
      method: "POST",
      url: `/api/workflows/${workflow.id}/schedules`,
      headers: { cookie: user.cookie },
      payload: { recurrence: { kind: "days", every: 1, time: "03:00" }, timezone: "Europe/Rome" }
    });

    const other = await registerUser(ctx.app, `estraneo-${Date.now()}@example.com`);
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/schedules/upcoming",
      headers: { cookie: other.cookie }
    });
    expect(response.json()).toEqual([]);
  });
});
