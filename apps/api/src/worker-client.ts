import { request } from "undici";
import type { RecordedAction, Step } from "@app/workflow-schema";

export interface WorkerSessionInfo {
  sessionId: string;
  userId: string;
  state: "creating" | "ready" | "running" | "closed" | "error";
  vncPort: number;
  startUrl: string;
  recording: boolean;
  highlight: boolean;
  tooltip?: boolean;
  armedFinal?: boolean;
  currentUrl?: string | null;
  pages?: Array<{ pageId: string; url: string; active: boolean }>;
  error?: string | null;
  expiresAt?: string;
}

export interface WorkerRecording {
  actions: RecordedAction[];
  steps: Step[];
  credentials: Array<{ name: string }>;
  /**
   * Captured secret values. They must be persisted encrypted by the API and
   * never forwarded to the browser.
   */
  credentialValues?: Array<{ name: string; value: string }>;
  skipped: number;
  /** Per-step outcome of checking the selector against the live page. */
  verifications?: Array<{ status: string; message?: string; usedFallback?: boolean }>;
}

export class WorkerHttpError extends Error {
  constructor(
    message: string,
    readonly statusCode: number
  ) {
    super(message);
  }
}

/** Thin HTTP client for the worker's private control API. */
export class WorkerClient {
  constructor(private readonly baseUrl: string) {}

  private async call<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown
  ): Promise<T> {
    const res = await request(`${this.baseUrl}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      headersTimeout: 120_000,
      bodyTimeout: 120_000
    });
    const text = await res.body.text();
    if (res.statusCode >= 400) {
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        /* keep raw text */
      }
      throw new WorkerHttpError(message || `Worker responded ${res.statusCode}`, res.statusCode);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  createSession(input: {
    sessionId: string;
    userId: string;
    startUrl: string;
    timeoutMs: number;
  }): Promise<WorkerSessionInfo> {
    return this.call("POST", "/sessions", input);
  }

  listSessions(): Promise<
    Array<{
      sessionId: string;
      userId: string;
      state: string;
      startUrl: string;
      currentUrl: string | null;
      recording: boolean;
      idleMs: number;
      expiresAt: string;
    }>
  > {
    return this.call("GET", "/sessions");
  }

  getSession(sessionId: string): Promise<WorkerSessionInfo> {
    return this.call("GET", `/sessions/${sessionId}`);
  }

  closeSession(sessionId: string): Promise<{ closed: boolean }> {
    return this.call("DELETE", `/sessions/${sessionId}`);
  }

  setRecording(sessionId: string, enabled: boolean): Promise<WorkerSessionInfo> {
    return this.call("POST", `/sessions/${sessionId}/recording`, { enabled });
  }

  setArmedFinal(sessionId: string, enabled: boolean): Promise<WorkerSessionInfo> {
    return this.call("POST", `/sessions/${sessionId}/arm-final`, { enabled });
  }

  setHighlight(sessionId: string, enabled: boolean): Promise<WorkerSessionInfo> {
    return this.call("POST", `/sessions/${sessionId}/highlight`, { enabled });
  }

  setTooltip(sessionId: string, enabled: boolean): Promise<WorkerSessionInfo> {
    return this.call("POST", `/sessions/${sessionId}/tooltip`, { enabled });
  }

  getRecording(sessionId: string): Promise<WorkerRecording> {
    return this.call("GET", `/sessions/${sessionId}/recording`);
  }

  clearRecording(sessionId: string): Promise<WorkerSessionInfo> {
    return this.call("DELETE", `/sessions/${sessionId}/recording`);
  }

  navigate(sessionId: string, url: string): Promise<WorkerSessionInfo> {
    return this.call("POST", `/sessions/${sessionId}/navigate`, { url });
  }

  interact(sessionId: string, input: Record<string, unknown>): Promise<WorkerSessionInfo> {
    return this.call("POST", `/sessions/${sessionId}/interact`, input);
  }

  describeElement(
    sessionId: string,
    query: { selector: string; pageId?: string; frame?: string }
  ): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({ selector: query.selector });
    if (query.pageId) params.set("pageId", query.pageId);
    if (query.frame) params.set("frame", query.frame);
    return this.call("GET", `/sessions/${sessionId}/element?${params.toString()}`);
  }

  switchPage(sessionId: string, pageId: string): Promise<WorkerSessionInfo> {
    return this.call("POST", `/sessions/${sessionId}/switch-page`, { pageId });
  }

  addWait(sessionId: string, ms: number): Promise<WorkerSessionInfo> {
    return this.call("POST", `/sessions/${sessionId}/wait`, { ms });
  }

  health(): Promise<{ status: string; sessions: number }> {
    return this.call("GET", "/health");
  }
}
