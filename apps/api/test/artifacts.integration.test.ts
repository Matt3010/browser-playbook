import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readdir, stat } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import {
  createTestContext,
  destroyTestContext,
  resetDatabase,
  registerUser,
  createWorkflow,
  type TestContext,
  type AuthedUser
} from "./helpers";

let ctx: TestContext;
let user: AuthedUser;
let artifactDir: string;

beforeAll(async () => {
  artifactDir = await mkdtemp(path.join(tmpdir(), "artifacts-test-"));
  ctx = await createTestContext({ ARTIFACT_DIR: artifactDir });
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  user = await registerUser(ctx.app, "owner@example.com");
});

/** Creates an execution with a screenshot on disk, as a real failed run would. */
async function executionWithArtifact(workflowId: string) {
  const execution = await ctx.prisma.execution.create({
    data: { workflowId, status: "failed" }
  });
  const dir = path.join(artifactDir, execution.id);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "error.png");
  await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await ctx.prisma.artifact.create({
    data: { executionId: execution.id, type: "screenshot", path: file }
  });
  return { execution, dir, file };
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

describe("artifact files on disk", () => {
  it("serves a stored screenshot", async () => {
    const workflow = await createWorkflow(ctx.app, user.cookie);
    const { execution } = await executionWithArtifact(workflow.id);
    const artifact = await ctx.prisma.artifact.findFirst({
      where: { executionId: execution.id }
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/artifacts/${artifact!.id}/file`,
      headers: { cookie: user.cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
  });

  it("removes the files from disk when the workflow is deleted", async () => {
    const workflow = await createWorkflow(ctx.app, user.cookie);
    const first = await executionWithArtifact(workflow.id);
    const second = await executionWithArtifact(workflow.id);

    expect(await exists(first.file)).toBe(true);
    expect(await exists(second.file)).toBe(true);

    const response = await ctx.app.inject({
      method: "DELETE",
      url: `/api/workflows/${workflow.id}`,
      headers: { cookie: user.cookie }
    });
    expect(response.statusCode).toBe(204);

    // The database rows go with the cascade; the files must go too, otherwise
    // every deleted workflow leaves its screenshots on the volume forever.
    expect(await ctx.prisma.artifact.count()).toBe(0);
    expect(await exists(first.dir), "the execution directory must be removed").toBe(false);
    expect(await exists(second.dir), "the execution directory must be removed").toBe(false);
  });

  it("leaves other workflows' artifacts untouched", async () => {
    const mine = await createWorkflow(ctx.app, user.cookie, "Mine");
    const other = await createWorkflow(ctx.app, user.cookie, "Other");
    const deleted = await executionWithArtifact(mine.id);
    const kept = await executionWithArtifact(other.id);

    await ctx.app.inject({
      method: "DELETE",
      url: `/api/workflows/${mine.id}`,
      headers: { cookie: user.cookie }
    });

    expect(await exists(deleted.dir)).toBe(false);
    expect(await exists(kept.file)).toBe(true);
  });

  it("deletes the workflow even when its artifact directory is already gone", async () => {
    const workflow = await createWorkflow(ctx.app, user.cookie);
    const execution = await ctx.prisma.execution.create({
      data: { workflowId: workflow.id, status: "failed" }
    });
    await ctx.prisma.artifact.create({
      data: {
        executionId: execution.id,
        type: "screenshot",
        path: path.join(artifactDir, execution.id, "missing.png")
      }
    });

    const response = await ctx.app.inject({
      method: "DELETE",
      url: `/api/workflows/${workflow.id}`,
      headers: { cookie: user.cookie }
    });
    expect(response.statusCode).toBe(204);
    expect(await ctx.prisma.workflow.count()).toBe(0);
  });

  it("refuses to serve a path in a sibling directory with the same prefix", async () => {
    // `startsWith(root)` without a separator lets `<root>-evil` through, because
    // the string starts with the root. Not reachable today (the worker writes the
    // paths) but the containment check must hold on its own.
    const sibling = `${artifactDir}-evil`;
    await mkdir(sibling, { recursive: true });
    const outside = path.join(sibling, "secret.png");
    await writeFile(outside, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const workflow = await createWorkflow(ctx.app, user.cookie);
    const execution = await ctx.prisma.execution.create({
      data: { workflowId: workflow.id, status: "failed" }
    });
    const artifact = await ctx.prisma.artifact.create({
      data: { executionId: execution.id, type: "screenshot", path: outside }
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/artifacts/${artifact.id}/file`,
      headers: { cookie: user.cookie }
    });
    expect(response.statusCode).toBe(400);
  });

  it("serves nothing for the artifact directory itself", async () => {
    const workflow = await createWorkflow(ctx.app, user.cookie);
    const execution = await ctx.prisma.execution.create({
      data: { workflowId: workflow.id, status: "failed" }
    });
    const artifact = await ctx.prisma.artifact.create({
      data: { executionId: execution.id, type: "screenshot", path: artifactDir }
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/artifacts/${artifact.id}/file`,
      headers: { cookie: user.cookie }
    });
    expect(response.statusCode).toBe(400);
  });

  it("never deletes anything outside the artifact directory", async () => {
    const outside = path.join(artifactDir, "..", "must-survive.txt");
    await writeFile(outside, "important");

    const workflow = await createWorkflow(ctx.app, user.cookie);
    const execution = await ctx.prisma.execution.create({
      data: { workflowId: workflow.id, status: "failed" }
    });
    // A row whose path escapes the artifact root must not lead to its removal.
    await ctx.prisma.artifact.create({
      data: { executionId: execution.id, type: "screenshot", path: outside }
    });

    await ctx.app.inject({
      method: "DELETE",
      url: `/api/workflows/${workflow.id}`,
      headers: { cookie: user.cookie }
    });

    expect(await exists(outside), "a path outside the artifact root must survive").toBe(true);
    const remaining = await readdir(path.dirname(artifactDir));
    expect(remaining).toContain("must-survive.txt");
  });
});
