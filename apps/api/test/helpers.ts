import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@app/database";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";
import { ExecutionQueue } from "../src/queue";
import type { WorkerClient, WorkerSessionInfo, WorkerRecording } from "../src/worker-client";
import { WorkerHttpError } from "../src/worker-client";
import type { RecordedAction, Step } from "@app/workflow-schema";

export const TEST_PASSWORD = "TestPassword123!";

/**
 * In-memory stand-in for the browser worker. Session behaviour is exercised for
 * real in the e2e suite; here it lets the API contract be tested deterministically.
 */
export class FakeWorkerClient implements Pick<
  WorkerClient,
  | "createSession"
  | "getSession"
  | "closeSession"
  | "setRecording"
  | "setHighlight"
  | "getRecording"
  | "navigate"
  | "health"
> {
  readonly sessions = new Map<string, WorkerSessionInfo>();
  recordedActions: RecordedAction[] = [];
  recordedSteps: Step[] = [];
  healthy = true;
  private nextPort = 15900;

  async createSession(input: {
    sessionId: string;
    userId: string;
    startUrl: string;
    timeoutMs: number;
  }): Promise<WorkerSessionInfo> {
    const info: WorkerSessionInfo = {
      sessionId: input.sessionId,
      userId: input.userId,
      state: "ready",
      vncPort: this.nextPort++,
      startUrl: input.startUrl,
      recording: false,
      highlight: true,
      currentUrl: input.startUrl,
      pages: [{ pageId: "main", url: input.startUrl, active: true }],
      error: null,
      expiresAt: new Date(Date.now() + input.timeoutMs).toISOString()
    };
    this.sessions.set(input.sessionId, info);
    return info;
  }

  async getSession(sessionId: string): Promise<WorkerSessionInfo> {
    const info = this.sessions.get(sessionId);
    if (!info) throw new WorkerHttpError("Session not found", 404);
    return info;
  }

  async closeSession(sessionId: string): Promise<{ closed: boolean }> {
    const info = this.sessions.get(sessionId);
    if (!info) throw new WorkerHttpError("Session not found", 404);
    info.state = "closed";
    return { closed: true };
  }

  async setRecording(sessionId: string, enabled: boolean): Promise<WorkerSessionInfo> {
    const info = await this.getSession(sessionId);
    info.recording = enabled;
    info.state = enabled ? "running" : "ready";
    return info;
  }

  async setHighlight(sessionId: string, enabled: boolean): Promise<WorkerSessionInfo> {
    const info = await this.getSession(sessionId);
    info.highlight = enabled;
    return info;
  }

  async getRecording(sessionId: string): Promise<WorkerRecording> {
    await this.getSession(sessionId);
    return {
      actions: this.recordedActions,
      steps: this.recordedSteps,
      credentials: [],
      skipped: 0
    };
  }

  async navigate(sessionId: string, url: string): Promise<WorkerSessionInfo> {
    const info = await this.getSession(sessionId);
    info.currentUrl = url;
    return info;
  }

  async health(): Promise<{ status: string; sessions: number }> {
    if (!this.healthy) throw new Error("worker down");
    return { status: "ok", sessions: this.sessions.size };
  }
}

export interface TestContext {
  app: FastifyInstance;
  prisma: PrismaClient;
  queue: ExecutionQueue;
  worker: FakeWorkerClient;
}

export async function createTestContext(): Promise<TestContext> {
  const config = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    JWT_SECRET: process.env.JWT_SECRET ?? "integration_test_secret_value",
    CREDENTIALS_ENC_KEY:
      process.env.CREDENTIALS_ENC_KEY ?? "0123456789abcdef0123456789abcdef",
    ALLOW_PRIVATE_TARGETS: "true",
    RATE_LIMIT_MAX: "100000",
    REGISTER_RATE_LIMIT_MAX: "100000",
    LOGIN_RATE_LIMIT_MAX: "100000",
    LOG_LEVEL: "silent"
  } as NodeJS.ProcessEnv);

  const prisma = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
  const queue = new ExecutionQueue(config.redisUrl);
  const worker = new FakeWorkerClient();

  const app = await buildApp({
    config,
    prisma,
    queue,
    worker: worker as unknown as WorkerClient
  });
  await app.ready();
  return { app, prisma, queue, worker };
}

export async function destroyTestContext(ctx: TestContext): Promise<void> {
  await ctx.app.close();
  await ctx.prisma.$disconnect();
}

/** Wipes all application tables so each test starts from a known state. */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "artifacts", "execution_logs", "executions", "schedules",
       "workflow_steps", "workflows", "credentials", "notifications", "users"
     RESTART IDENTITY CASCADE`
  );
}

export interface AuthedUser {
  id: string;
  email: string;
  cookie: string;
}

/** Registers a user through the real API and returns its session cookie. */
export async function registerUser(
  app: FastifyInstance,
  email: string,
  password = TEST_PASSWORD
): Promise<AuthedUser> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email, password }
  });
  if (response.statusCode !== 201) {
    throw new Error(`registerUser failed: ${response.statusCode} ${response.body}`);
  }
  const setCookie = response.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!raw) throw new Error("registerUser: no session cookie returned");
  const cookie = raw.split(";")[0];
  const body = response.json<{ id: string; email: string }>();
  return { id: body.id, email: body.email, cookie };
}

export async function createWorkflow(
  app: FastifyInstance,
  cookie: string,
  name = "Test workflow",
  startUrl = "http://test-web:3001/login"
): Promise<{ id: string; name: string; startUrl: string; status: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/workflows",
    headers: { cookie },
    payload: { name, startUrl }
  });
  if (response.statusCode !== 201) {
    throw new Error(`createWorkflow failed: ${response.statusCode} ${response.body}`);
  }
  return response.json();
}

let stepCounter = 0;
export function stepId(): string {
  stepCounter += 1;
  return `00000000-0000-4000-8000-${String(stepCounter).padStart(12, "0")}`;
}

export function gotoStep(url: string): Record<string, unknown> {
  return {
    id: stepId(),
    type: "goto",
    name: `Vai a ${url}`,
    pageId: "main",
    selector: null,
    value: url,
    timeoutMs: 10000,
    enabled: true
  };
}

export function fillStep(label: string, value: string): Record<string, unknown> {
  return {
    id: stepId(),
    type: "fill",
    name: `Inserisci ${label}`,
    pageId: "main",
    selector: { strategy: "label", value: label, fallback: null, pageId: "main", frame: null },
    value,
    timeoutMs: 10000,
    enabled: true
  };
}

export function clickStep(name: string): Record<string, unknown> {
  return {
    id: stepId(),
    type: "click",
    name: `Clicca ${name}`,
    pageId: "main",
    selector: { strategy: "role", role: "button", name, fallback: null, pageId: "main", frame: null },
    value: null,
    timeoutMs: 10000,
    enabled: true
  };
}
