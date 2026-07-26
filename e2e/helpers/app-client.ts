/**
 * Minimal HTTP client for the application API, used by the e2e specs to drive
 * the product the same way the frontend does (session cookie, same origin).
 */
export const APP_BASE_URL = process.env.APP_BASE_URL ?? "http://localhost:8081";
export const TEST_WEB_PUBLIC_URL = process.env.TEST_WEB_PUBLIC_URL ?? "http://localhost:3901";
/** How test-web is reachable from inside the Docker network. */
export const TEST_WEB_INTERNAL_URL = "http://test-web:3001";
/** The same fake application under a second hostname, to simulate another site. */
export const SHOP_WEB_INTERNAL_URL = "http://shop-web:3001";

export const SEED_EMAIL = "test@example.com";
export const SEED_PASSWORD = "TestPassword123!";

export interface Step {
  id: string;
  type: string;
  name: string;
  pageId: string;
  selector: Record<string, unknown> | null;
  value: string | null;
  timeoutMs: number;
  enabled: boolean;
  isFinal?: boolean;
}

export interface Execution {
  id: string;
  status: string;
  errorMessage: string | null;
  failedStepId: string | null;
  currentUrl: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs?: number | null;
  logs?: Array<{ id: string; level: string; message: string; stepId: string | null }>;
  artifacts?: Array<{ id: string; type: string; path: string }>;
}

export class AppClient {
  private cookie = "";

  constructor(readonly baseUrl: string = APP_BASE_URL) {}

  get sessionCookie(): string {
    return this.cookie;
  }

  async request(
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; text: string; json: <T>() => T }> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const setCookie = response.headers.getSetCookie?.() ?? [];
    for (const raw of setCookie) {
      if (raw.startsWith("session=")) {
        const value = raw.split(";")[0];
        // An empty value means the server cleared the cookie (logout).
        this.cookie = value === "session=" ? "" : value;
      }
    }
    const text = await response.text();
    return {
      status: response.status,
      text,
      json: <T>() => JSON.parse(text) as T
    };
  }

  private async ok<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.request(method, path, body);
    if (response.status >= 400) {
      throw new Error(`${method} ${path} failed: ${response.status} ${response.text}`);
    }
    return response.text ? (JSON.parse(response.text) as T) : (undefined as T);
  }

  login(email = SEED_EMAIL, password = SEED_PASSWORD) {
    return this.ok<{ id: string; email: string }>("POST", "/api/auth/login", { email, password });
  }

  register(email: string, password = SEED_PASSWORD) {
    return this.ok<{ id: string; email: string }>("POST", "/api/auth/register", {
      email,
      password
    });
  }

  me() {
    return this.ok<{ id: string; email: string }>("GET", "/api/auth/me");
  }

  createWorkflow(name: string, startUrl: string) {
    return this.ok<{ id: string; name: string; status: string }>("POST", "/api/workflows", {
      name,
      startUrl
    });
  }

  getWorkflow(id: string) {
    return this.ok<{ id: string; status: string; steps: Step[] }>("GET", `/api/workflows/${id}`);
  }

  putSteps(workflowId: string, steps: unknown[]) {
    return this.ok<Step[]>("PUT", `/api/workflows/${workflowId}/steps`, { steps });
  }

  createSession(startUrl: string, timeoutMs?: number) {
    return this.ok<{
      sessionId: string;
      state: string;
      token: string;
      vncPath: string;
      expiresAt?: string;
    }>("POST", "/api/sessions", { startUrl, ...(timeoutMs ? { timeoutMs } : {}) });
  }

  getSession(sessionId: string) {
    return this.ok<{
      sessionId: string;
      state: string;
      recording: boolean;
      highlight: boolean;
      currentUrl: string | null;
      pages: Array<{ pageId: string; url: string; active: boolean }>;
    }>("GET", `/api/sessions/${sessionId}`);
  }

  closeSession(sessionId: string) {
    return this.ok<{ closed: boolean }>("DELETE", `/api/sessions/${sessionId}`);
  }

  setRecording(sessionId: string, enabled: boolean) {
    return this.ok("POST", `/api/sessions/${sessionId}/recording`, { enabled });
  }

  armFinal(sessionId: string, enabled: boolean) {
    return this.ok("POST", `/api/sessions/${sessionId}/arm-final`, { enabled });
  }

  setHighlight(sessionId: string, enabled: boolean) {
    return this.ok("POST", `/api/sessions/${sessionId}/highlight`, { enabled });
  }

  getRecording(sessionId: string) {
    return this.ok<{
      steps: Step[];
      credentials: Array<{ name: string }>;
      skipped: number;
      verifications?: Array<{ status: string; message?: string }>;
    }>("GET", `/api/sessions/${sessionId}/recording`);
  }

  saveRecordedCredentials(sessionId: string) {
    return this.ok<{ saved: string[] }>("POST", `/api/sessions/${sessionId}/credentials`);
  }

  interact(sessionId: string, input: Record<string, unknown>) {
    return this.ok("POST", `/api/sessions/${sessionId}/interact`, input);
  }

  navigateSession(sessionId: string, url: string) {
    return this.ok("POST", `/api/sessions/${sessionId}/navigate`, { url });
  }

  switchSessionPage(sessionId: string, pageId: string) {
    return this.ok("POST", `/api/sessions/${sessionId}/switch-page`, { pageId });
  }

  runNow(workflowId: string) {
    return this.ok<{ id: string; status: string }>(
      "POST",
      `/api/workflows/${workflowId}/executions`
    );
  }

  cancelExecution(id: string) {
    return this.request("POST", `/api/executions/${id}/cancel`);
  }

  getExecution(id: string) {
    return this.ok<Execution>("GET", `/api/executions/${id}`);
  }

  listExecutions(workflowId?: string) {
    return this.ok<Execution[]>(
      "GET",
      `/api/executions${workflowId ? `?workflowId=${workflowId}` : ""}`
    );
  }

  schedule(workflowId: string, runAt: string, timezone = "Europe/Rome") {
    return this.ok<{ id: string; status: string; queueJobId: string; executionId: string }>(
      "POST",
      `/api/workflows/${workflowId}/schedules`,
      { runAt, timezone }
    );
  }

  getSchedule(id: string) {
    return this.ok<{ id: string; status: string; jobState: string | null }>(
      "GET",
      `/api/schedules/${id}`
    );
  }

  cancelSchedule(id: string) {
    return this.request("DELETE", `/api/schedules/${id}`);
  }

  saveCredential(name: string, value: string, kind: "variable" | "secret") {
    return this.ok<{ id: string; name: string }>("POST", "/api/credentials", {
      name,
      value,
      kind
    });
  }

  listCredentials() {
    return this.ok<Array<{ id: string; name: string; kind: string; value: string | null }>>(
      "GET",
      "/api/credentials"
    );
  }

  notifications() {
    return this.ok<{
      items: Array<{ id: string; type: string; title: string; message: string }>;
      unread: number;
    }>("GET", "/api/notifications");
  }

  /** Polls until the execution reaches a terminal state. */
  async waitForExecution(id: string, timeoutMs = 150_000): Promise<Execution> {
    const deadline = Date.now() + timeoutMs;
    let last: Execution | null = null;
    while (Date.now() < deadline) {
      last = await this.getExecution(id);
      if (["completed", "failed", "cancelled"].includes(last.status)) return last;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(
      `Execution ${id} did not finish within ${timeoutMs} ms (last status: ${last?.status})`
    );
  }
}

// ---- test-web control ------------------------------------------------------

export interface TestWebState {
  config: {
    dashboardDelayMs: number;
    delayedButtonMs: number;
    missingElement: boolean;
    failApi: boolean;
    rejectLogin: boolean;
  };
  wizardSubmissions: Array<{
    name: string;
    email: string;
    plan: string;
    newsletter: boolean;
    notes: string;
  }>;
  uploads: Array<{ filename: string; size: number; content: string }>;
  orders: Array<{ note: string; placedAt: string }>;
  loginAttempts: number;
}

export async function resetTestWeb(): Promise<void> {
  const response = await fetch(`${TEST_WEB_PUBLIC_URL}/api/test/reset`, { method: "POST" });
  if (!response.ok) throw new Error(`test-web reset failed: ${response.status}`);
}

export async function configureTestWeb(patch: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${TEST_WEB_PUBLIC_URL}/api/test/configure`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch)
  });
  if (!response.ok) {
    throw new Error(`test-web configure failed: ${response.status} ${await response.text()}`);
  }
}

export async function getTestWebState(): Promise<TestWebState> {
  const response = await fetch(`${TEST_WEB_PUBLIC_URL}/api/test/state`);
  if (!response.ok) throw new Error(`test-web state failed: ${response.status}`);
  return (await response.json()) as TestWebState;
}

// ---- step builders ---------------------------------------------------------

export function uuid(): string {
  return crypto.randomUUID();
}

export function step(partial: Partial<Step> & { type: string; name: string }): Step {
  return {
    id: uuid(),
    pageId: "main",
    selector: null,
    value: null,
    timeoutMs: 15000,
    enabled: true,
    ...partial
  } as Step;
}
