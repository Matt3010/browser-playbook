import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, stat, utimes } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { PrismaClient } from "@app/database";
import { hashPassword, createLogger } from "@app/shared";
import { pruneBrowserProfiles, pruneOldHistory } from "../src/retention";

/**
 * Nothing ever deleted an execution log, a notification or a screenshot: they only
 * went away when the whole workflow was deleted. A workflow running every night on
 * a Raspberry Pi with an SD card grows them without a ceiling.
 */
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL as string } }
});
const log = createLogger("worker-retention-test");

const DAY = 24 * 60 * 60 * 1000;

let userId: string;
let workflowId: string;
let artifactDir: string;

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** An execution that finished `ageDays` ago, with a log line and a screenshot. */
async function agedExecution(ageDays: number) {
  const finishedAt = new Date(Date.now() - ageDays * DAY);
  const execution = await prisma.execution.create({
    data: { workflowId, status: "completed", startedAt: finishedAt, finishedAt }
  });
  await prisma.executionLog.create({
    data: { executionId: execution.id, level: "info", message: `run of ${ageDays} days ago` }
  });
  const dir = path.join(artifactDir, execution.id);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "error.png");
  await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await prisma.artifact.create({
    data: { executionId: execution.id, type: "screenshot", path: file }
  });
  return { execution, dir };
}

beforeAll(async () => {
  await prisma.$connect();
  artifactDir = await mkdtemp(path.join(tmpdir(), "retention-test-"));
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "artifacts", "execution_logs", "executions", "schedules",
       "workflow_steps", "workflows", "credentials", "notifications", "users"
     RESTART IDENTITY CASCADE`
  );
  const user = await prisma.user.create({
    data: { email: "retention@example.com", passwordHash: await hashPassword("TestPassword123!") }
  });
  userId = user.id;
  const workflow = await prisma.workflow.create({
    data: { userId, name: "Notturno", startUrl: "http://test-web:3001/login", status: "ready" }
  });
  workflowId = workflow.id;
});

describe("pruning history that nobody will read again", () => {
  it("removes the logs, artifacts and files of runs past the retention window", async () => {
    const old = await agedExecution(40);

    const result = await pruneOldHistory({ prisma, log, artifactDir, retentionDays: 30 });

    expect(result.executions).toBe(1);
    expect(await prisma.executionLog.count({ where: { executionId: old.execution.id } })).toBe(0);
    expect(await prisma.artifact.count({ where: { executionId: old.execution.id } })).toBe(0);
    // Files outlive their rows unless something removes them explicitly.
    expect(await exists(old.dir), "the artifact directory must be gone").toBe(false);
    // The execution row itself stays: it is one row, and it is the history.
    expect(await prisma.execution.count({ where: { id: old.execution.id } })).toBe(1);
  });

  it("leaves recent runs completely alone", async () => {
    const recent = await agedExecution(3);

    await pruneOldHistory({ prisma, log, artifactDir, retentionDays: 30 });

    expect(await prisma.executionLog.count({ where: { executionId: recent.execution.id } })).toBe(1);
    expect(await exists(recent.dir)).toBe(true);
  });

  it("never touches a run that has not finished", async () => {
    // An execution still running has no finishedAt. Reading that as "infinitely old"
    // would delete the logs of the run currently streaming them to the user.
    const running = await prisma.execution.create({
      data: {
        workflowId,
        status: "running",
        startedAt: new Date(Date.now() - 90 * DAY),
        finishedAt: null
      }
    });
    await prisma.executionLog.create({
      data: { executionId: running.id, level: "info", message: "step 1" }
    });

    await pruneOldHistory({ prisma, log, artifactDir, retentionDays: 30 });

    expect(await prisma.executionLog.count({ where: { executionId: running.id } })).toBe(1);
  });

  it("removes old notifications and keeps recent ones", async () => {
    await prisma.notification.create({
      data: {
        userId,
        type: "execution_failed",
        title: "Vecchia",
        message: "vecchia",
        createdAt: new Date(Date.now() - 40 * DAY)
      }
    });
    await prisma.notification.create({
      data: { userId, type: "execution_failed", title: "Nuova", message: "nuova" }
    });

    const result = await pruneOldHistory({ prisma, log, artifactDir, retentionDays: 30 });

    expect(result.notifications).toBe(1);
    const left = await prisma.notification.findMany({ where: { userId } });
    expect(left.map((n) => n.title)).toEqual(["Nuova"]);
  });

  it("refuses to delete outside the artifact root", async () => {
    // The path stored on an artifact row is data. If it ever pointed elsewhere,
    // pruning must not follow it out of the volume it owns.
    const outside = await mkdtemp(path.join(tmpdir(), "not-artifacts-"));
    const file = path.join(outside, "keep.png");
    await writeFile(file, Buffer.from([1]));
    const finishedAt = new Date(Date.now() - 40 * DAY);
    const execution = await prisma.execution.create({
      data: { workflowId, status: "failed", startedAt: finishedAt, finishedAt }
    });
    await prisma.artifact.create({
      data: { executionId: execution.id, type: "screenshot", path: file }
    });

    await pruneOldHistory({ prisma, log, artifactDir, retentionDays: 30 });

    expect(await exists(file), "a path outside the root must survive").toBe(true);
  });
});

describe("pruneBrowserProfiles", () => {
  let profileDir: string;

  /** A profile directory for a workflow, last used `ageDays` ago. */
  async function agedProfile(owner: string, workflow: string, ageDays: number) {
    const directory = path.join(profileDir, owner, workflow);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "Cookies"), "cookie-jar");
    const when = new Date(Date.now() - ageDays * DAY);
    await utimes(directory, when, when);
    return directory;
  }

  beforeEach(async () => {
    profileDir = await mkdtemp(path.join(tmpdir(), "profiles-test-"));
  });

  it("keeps the profile of a workflow that is still there and still used", async () => {
    const directory = await agedProfile(userId, workflowId, 1);
    const result = await pruneBrowserProfiles({ prisma, log, profileDir, retentionDays: 60 });
    expect(result).toEqual({ orphaned: 0, stale: 0 });
    expect(await exists(directory)).toBe(true);
  });

  it("removes the profile of a workflow that no longer exists", async () => {
    // Deleting a workflow deletes its rows, and the volume would otherwise keep
    // its browser — with the cookies of the site it logged into — for ever.
    const directory = await agedProfile(userId, workflowId, 1);
    await prisma.workflow.delete({ where: { id: workflowId } });

    const result = await pruneBrowserProfiles({ prisma, log, profileDir, retentionDays: 60 });
    expect(result.orphaned).toBe(1);
    expect(await exists(directory)).toBe(false);
  });

  it("removes a profile nothing has opened for longer than the retention", async () => {
    const old = await agedProfile(userId, workflowId, 90);
    const result = await pruneBrowserProfiles({ prisma, log, profileDir, retentionDays: 60 });
    expect(result.stale).toBe(1);
    expect(await exists(old)).toBe(false);
  });

  it("keeps every profile when the retention is disabled, except the orphans", async () => {
    const old = await agedProfile(userId, workflowId, 500);
    const result = await pruneBrowserProfiles({ prisma, log, profileDir, retentionDays: 0 });
    expect(result).toEqual({ orphaned: 0, stale: 0 });
    expect(await exists(old)).toBe(true);
  });

  it("does not touch the profile of another user with the same workflow id", async () => {
    // The layout is <root>/<userId>/<workflowId>: a workflow id belonging to one
    // user says nothing about a directory under another one, and that directory
    // has no workflow of its own — so it goes as an orphan, and the real one stays.
    const mine = await agedProfile(userId, workflowId, 1);
    const stranger = await agedProfile("00000000-0000-4000-8000-000000000000", workflowId, 1);

    const result = await pruneBrowserProfiles({ prisma, log, profileDir, retentionDays: 60 });
    expect(result.orphaned).toBe(1);
    expect(await exists(mine)).toBe(true);
    expect(await exists(stranger)).toBe(false);
  });

  it("says nothing and does nothing when no profile has ever been kept", async () => {
    const result = await pruneBrowserProfiles({
      prisma,
      log,
      profileDir: path.join(profileDir, "never-created"),
      retentionDays: 60
    });
    expect(result).toEqual({ orphaned: 0, stale: 0 });
  });
});
