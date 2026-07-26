/**
 * Browser-side API client. Everything is served through the same origin (the
 * reverse proxy), so the session cookie travels automatically and no token has
 * to be handled in JavaScript.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: string[]
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "include",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store"
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const parsed = text ? safeJson(text) : undefined;

  if (!response.ok) {
    const message =
      (parsed as { error?: string } | undefined)?.error ?? `Request failed (${response.status})`;
    throw new ApiError(message, response.status, (parsed as { details?: string[] })?.details);
  }
  return parsed as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  del: <T>(path: string) => request<T>("DELETE", path)
};

// ---- shared types mirrored from the API ----------------------------------

export interface Selector {
  strategy: string;
  value?: string;
  role?: string;
  name?: string;
  fallback?: string | null;
  pageId: string;
  frame?: string | null;
}

export interface Step {
  id: string;
  type: string;
  name: string;
  pageId: string;
  selector: Selector | null;
  value: string | null;
  timeoutMs: number;
  enabled: boolean;
  /** Recorded without being performed; must stay the last enabled step. */
  isFinal: boolean;
}

export interface Workflow {
  id: string;
  name: string;
  startUrl: string;
  status: "draft" | "ready" | "disabled";
  createdAt: string;
  updatedAt: string;
  stepCount?: number;
  executionCount?: number;
  steps?: Step[];
}

export interface Execution {
  id: string;
  workflowId: string;
  scheduleId: string | null;
  status: "queued" | "starting" | "running" | "completed" | "failed" | "cancelled";
  startedAt: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
  failedStepId: string | null;
  currentUrl: string | null;
  createdAt: string;
  durationMs?: number | null;
  workflow?: { id: string; name: string };
  logs?: ExecutionLog[];
  artifacts?: Artifact[];
}

export interface ExecutionLog {
  id: string;
  stepId: string | null;
  level: string;
  message: string;
  createdAt: string;
}

export interface Artifact {
  id: string;
  type: string;
  path: string;
  createdAt: string;
}

export interface Schedule {
  id: string;
  workflowId: string;
  runAt: string;
  timezone: string;
  status: "scheduled" | "queued" | "cancelled" | "completed" | "failed";
  queueJobId: string | null;
  jobState?: string | null;
  executions?: Array<{ id: string; status: string }>;
}

export interface CredentialEntry {
  id: string;
  name: string;
  kind: "variable" | "secret";
  value: string | null;
  hasValue: boolean;
}

export interface NotificationEntry {
  id: string;
  type: string;
  title: string;
  message: string;
  readAt: string | null;
  createdAt: string;
}

export interface SessionInfo {
  sessionId: string;
  state: "creating" | "ready" | "running" | "closed" | "error";
  startUrl: string;
  currentUrl?: string | null;
  recording: boolean;
  highlight: boolean;
  armedFinal?: boolean;
  pages?: Array<{ pageId: string; url: string; active: boolean }>;
  error?: string | null;
  expiresAt?: string;
  token?: string;
  vncPath?: string;
}

export type StepVerificationStatus = "ok" | "ambiguous" | "not-found" | "unchecked";

export interface StepVerification {
  status: StepVerificationStatus;
  message?: string;
  usedFallback?: boolean;
}

export interface RecordingResult {
  actions: unknown[];
  steps: Step[];
  credentials: Array<{ name: string }>;
  credentialValues?: Array<{ name: string; value: string }>;
  skipped: number;
  /** Aligned with `steps`: whether each one resolves on the live page. */
  verifications: StepVerification[];
}
