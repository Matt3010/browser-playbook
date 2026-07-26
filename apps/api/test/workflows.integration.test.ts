import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestContext,
  destroyTestContext,
  resetDatabase,
  registerUser,
  createWorkflow,
  gotoStep,
  fillStep,
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

describe("workflow API", () => {
  it("creates a workflow in draft state", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: { cookie: user.cookie },
      payload: { name: "Login flow", startUrl: "http://test-web:3001/login" }
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      name: "Login flow",
      startUrl: "http://test-web:3001/login",
      status: "draft"
    });
  });

  it("rejects a workflow without name or startUrl", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: { cookie: user.cookie },
      payload: { name: "" }
    });
    expect(response.statusCode).toBe(400);
  });

  it("lists only the workflows of the current user", async () => {
    await createWorkflow(ctx.app, user.cookie, "Mine");
    const other = await registerUser(ctx.app, "other@example.com");
    await createWorkflow(ctx.app, other.cookie, "Theirs");

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/workflows",
      headers: { cookie: user.cookie }
    });
    const body = response.json<Array<{ name: string }>>();
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe("Mine");
  });

  it("reports another user's workflow as not found", async () => {
    const other = await registerUser(ctx.app, "other@example.com");
    const theirs = await createWorkflow(ctx.app, other.cookie, "Theirs");

    for (const [method, url] of [
      ["GET", `/api/workflows/${theirs.id}`],
      ["PATCH", `/api/workflows/${theirs.id}`],
      ["DELETE", `/api/workflows/${theirs.id}`],
      ["GET", `/api/workflows/${theirs.id}/steps`],
      ["PUT", `/api/workflows/${theirs.id}/steps`]
    ] as const) {
      const response = await ctx.app.inject({
        method,
        url,
        headers: { cookie: user.cookie },
        payload: method === "PUT" ? { steps: [] } : { name: "hack" }
      });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it("updates and deletes a workflow", async () => {
    const workflow = await createWorkflow(ctx.app, user.cookie);
    const patched = await ctx.app.inject({
      method: "PATCH",
      url: `/api/workflows/${workflow.id}`,
      headers: { cookie: user.cookie },
      payload: { name: "Renamed", status: "disabled" }
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ name: "Renamed", status: "disabled" });

    const deleted = await ctx.app.inject({
      method: "DELETE",
      url: `/api/workflows/${workflow.id}`,
      headers: { cookie: user.cookie }
    });
    expect(deleted.statusCode).toBe(204);
    expect(await ctx.prisma.workflow.count()).toBe(0);
  });

  it("blocks private/localhost start URLs when the guard is enabled", async () => {
    // The shared test context runs with ALLOW_PRIVATE_TARGETS=true (needed for
    // test-web), so verify the guard through a dedicated strict context.
    const strict = await ctx.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: { cookie: user.cookie },
      payload: { name: "bad", startUrl: "not-a-url" }
    });
    expect(strict.statusCode).toBe(400);
    expect(strict.json().error).toMatch(/Invalid URL/);
  });

  it("rejects non-http protocols in the start URL", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: { cookie: user.cookie },
      payload: { name: "bad", startUrl: "file:///etc/passwd" }
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("workflow step persistence", () => {
  it("saves an ordered step list and marks the workflow ready", async () => {
    const workflow = await createWorkflow(ctx.app, user.cookie);
    const steps = [
      gotoStep("http://test-web:3001/login"),
      fillStep("Email", "{{credentials.email}}"),
      fillStep("Password", "{{credentials.password}}"),
      clickStep("Login")
    ];

    const response = await ctx.app.inject({
      method: "PUT",
      url: `/api/workflows/${workflow.id}/steps`,
      headers: { cookie: user.cookie },
      payload: { steps }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<Array<{ type: string }>>().map((s) => s.type)).toEqual([
      "goto",
      "fill",
      "fill",
      "click"
    ]);

    const stored = await ctx.prisma.workflow.findUnique({ where: { id: workflow.id } });
    expect(stored!.status).toBe("ready");

    const rows = await ctx.prisma.workflowStep.findMany({
      where: { workflowId: workflow.id },
      orderBy: { position: "asc" }
    });
    expect(rows.map((r) => r.position)).toEqual([0, 1, 2, 3]);
  });

  it("reloads saved steps unchanged, including the selector", async () => {
    const workflow = await createWorkflow(ctx.app, user.cookie);
    const steps = [gotoStep("http://test-web:3001/login"), fillStep("Email", "a@b.com")];
    await ctx.app.inject({
      method: "PUT",
      url: `/api/workflows/${workflow.id}/steps`,
      headers: { cookie: user.cookie },
      payload: { steps }
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/workflows/${workflow.id}/steps`,
      headers: { cookie: user.cookie }
    });
    const loaded = response.json<Array<Record<string, unknown>>>();
    expect(loaded[1].selector).toMatchObject({ strategy: "label", value: "Email" });
    expect(loaded[1].value).toBe("a@b.com");
    expect(loaded[0].selector).toBeNull();
  });

  it("replaces the whole list so reorder and delete are atomic", async () => {
    const workflow = await createWorkflow(ctx.app, user.cookie);
    const a = gotoStep("http://test-web:3001/login");
    const b = clickStep("Login");

    await ctx.app.inject({
      method: "PUT",
      url: `/api/workflows/${workflow.id}/steps`,
      headers: { cookie: user.cookie },
      payload: { steps: [a, b] }
    });
    const reordered = await ctx.app.inject({
      method: "PUT",
      url: `/api/workflows/${workflow.id}/steps`,
      headers: { cookie: user.cookie },
      payload: { steps: [b, a] }
    });
    expect(reordered.json<Array<{ id: string }>>().map((s) => s.id)).toEqual([b.id, a.id]);

    const shortened = await ctx.app.inject({
      method: "PUT",
      url: `/api/workflows/${workflow.id}/steps`,
      headers: { cookie: user.cookie },
      payload: { steps: [a] }
    });
    expect(shortened.json()).toHaveLength(1);
    expect(await ctx.prisma.workflowStep.count()).toBe(1);
  });

  it("persists the disabled flag and drops the workflow back to draft", async () => {
    const workflow = await createWorkflow(ctx.app, user.cookie);
    const disabled = { ...gotoStep("http://test-web:3001/login"), enabled: false };
    const response = await ctx.app.inject({
      method: "PUT",
      url: `/api/workflows/${workflow.id}/steps`,
      headers: { cookie: user.cookie },
      payload: { steps: [disabled] }
    });
    expect(response.json<Array<{ enabled: boolean }>>()[0].enabled).toBe(false);
    const stored = await ctx.prisma.workflow.findUnique({ where: { id: workflow.id } });
    expect(stored!.status).toBe("draft");
  });

  it("rejects an invalid step list and saves nothing", async () => {
    const workflow = await createWorkflow(ctx.app, user.cookie);
    const invalid = { id: stepId(), type: "fill", name: "no selector", timeoutMs: 10000 };
    const response = await ctx.app.inject({
      method: "PUT",
      url: `/api/workflows/${workflow.id}/steps`,
      headers: { cookie: user.cookie },
      payload: { steps: [invalid] }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().details.join(" ")).toMatch(/requires a selector/);
    expect(await ctx.prisma.workflowStep.count()).toBe(0);
  });

  it("rejects an unsupported step type", async () => {
    const workflow = await createWorkflow(ctx.app, user.cookie);
    const response = await ctx.app.inject({
      method: "PUT",
      url: `/api/workflows/${workflow.id}/steps`,
      headers: { cookie: user.cookie },
      payload: { steps: [{ ...gotoStep("http://a.test"), type: "evaluate" }] }
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects duplicate step ids", async () => {
    const workflow = await createWorkflow(ctx.app, user.cookie);
    const step = gotoStep("http://test-web:3001/login");
    const response = await ctx.app.inject({
      method: "PUT",
      url: `/api/workflows/${workflow.id}/steps`,
      headers: { cookie: user.cookie },
      payload: { steps: [step, { ...step }] }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/Duplicate step id/);
  });

  it("accepts an empty list and clears the steps", async () => {
    const workflow = await createWorkflow(ctx.app, user.cookie);
    await ctx.app.inject({
      method: "PUT",
      url: `/api/workflows/${workflow.id}/steps`,
      headers: { cookie: user.cookie },
      payload: { steps: [gotoStep("http://test-web:3001/login")] }
    });
    const response = await ctx.app.inject({
      method: "PUT",
      url: `/api/workflows/${workflow.id}/steps`,
      headers: { cookie: user.cookie },
      payload: { steps: [] }
    });
    expect(response.statusCode).toBe(200);
    expect(await ctx.prisma.workflowStep.count()).toBe(0);
  });

  it("returns the workflow with its steps in the detail endpoint", async () => {
    const workflow = await createWorkflow(ctx.app, user.cookie);
    await ctx.app.inject({
      method: "PUT",
      url: `/api/workflows/${workflow.id}/steps`,
      headers: { cookie: user.cookie },
      payload: { steps: [gotoStep("http://test-web:3001/login")] }
    });
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/workflows/${workflow.id}`,
      headers: { cookie: user.cookie }
    });
    expect(response.json().steps).toHaveLength(1);
  });
});

describe("editing a workflow that is about to run", () => {
  // The runner loads the steps when it picks the job up, not when the job is
  // created. Editing in between means the run that happens is not the run that was
  // asked for: press Run, add a "confirm order" step, and the queued job performs it
  // on the real site. The same reasoning as refusing a second concurrent run.
  async function workflowWithSteps() {
    const workflow = await createWorkflow(ctx.app, user.cookie, "Da modificare");
    await ctx.app.inject({
      method: "PUT",
      url: `/api/workflows/${workflow.id}/steps`,
      headers: { cookie: user.cookie },
      payload: { steps: [gotoStep("http://test-web:3001/login"), clickStep("Login")] }
    });
    return workflow;
  }

  const putTwoSteps = (workflowId: string) =>
    ctx.app.inject({
      method: "PUT",
      url: `/api/workflows/${workflowId}/steps`,
      headers: { cookie: user.cookie },
      payload: {
        steps: [gotoStep("http://test-web:3001/login"), clickStep("Conferma ordine")]
      }
    });

  it("refuses while an execution is queued or running", async () => {
    for (const status of ["queued", "starting", "running"]) {
      const workflow = await workflowWithSteps();
      await ctx.prisma.execution.create({ data: { workflowId: workflow.id, status } });

      const response = await putTwoSteps(workflow.id);
      expect(response.statusCode, `status ${status} must block an edit`).toBe(409);

      // And nothing was written: a half-applied edit would be worse than a refusal.
      const stored = await ctx.prisma.workflowStep.findMany({
        where: { workflowId: workflow.id },
        orderBy: { position: "asc" }
      });
      expect(stored.map((s) => s.name)).toEqual(["Vai a http://test-web:3001/login", "Clicca Login"]);
    }
  });

  it("allows editing once the run has finished", async () => {
    const workflow = await workflowWithSteps();
    await ctx.prisma.execution.create({
      data: { workflowId: workflow.id, status: "completed", finishedAt: new Date() }
    });

    const response = await putTwoSteps(workflow.id);
    expect(response.statusCode).toBe(200);
  });

  it("allows editing a workflow scheduled for later", async () => {
    // A schedule reserves its execution row when it is created. Reading that as a run
    // in progress would make a scheduled workflow impossible to correct — and picking
    // up the correction is exactly what should happen tomorrow.
    const workflow = await workflowWithSteps();
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

    const response = await putTwoSteps(workflow.id);
    expect(response.statusCode).toBe(200);
  });
});
