export const WORKFLOW_STATES = ["draft", "ready", "disabled"] as const;
export const SCHEDULE_STATES = ["scheduled", "queued", "cancelled", "completed", "failed"] as const;
export const EXECUTION_STATES = [
  "queued",
  "starting",
  "running",
  "completed",
  "failed",
  "cancelled"
] as const;
export const BROWSER_SESSION_STATES = ["creating", "ready", "running", "closed", "error"] as const;

export type WorkflowState = (typeof WORKFLOW_STATES)[number];
export type ScheduleState = (typeof SCHEDULE_STATES)[number];
export type ExecutionState = (typeof EXECUTION_STATES)[number];
export type BrowserSessionState = (typeof BROWSER_SESSION_STATES)[number];

const WORKFLOW_TRANSITIONS: Record<WorkflowState, WorkflowState[]> = {
  draft: ["ready", "disabled"],
  ready: ["draft", "disabled"],
  disabled: ["ready", "draft"]
};

const SCHEDULE_TRANSITIONS: Record<ScheduleState, ScheduleState[]> = {
  scheduled: ["queued", "cancelled"],
  queued: ["completed", "failed", "cancelled"],
  cancelled: [],
  completed: [],
  failed: []
};

const EXECUTION_TRANSITIONS: Record<ExecutionState, ExecutionState[]> = {
  queued: ["starting", "cancelled", "failed"],
  starting: ["running", "failed", "cancelled"],
  running: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: []
};

const BROWSER_SESSION_TRANSITIONS: Record<BrowserSessionState, BrowserSessionState[]> = {
  creating: ["ready", "error", "closed"],
  ready: ["running", "closed", "error"],
  running: ["ready", "closed", "error"],
  error: ["closed"],
  closed: []
};

function can<T extends string>(map: Record<T, T[]>, from: T, to: T): boolean {
  const allowed = map[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

export function canTransitionWorkflow(from: WorkflowState, to: WorkflowState): boolean {
  return can(WORKFLOW_TRANSITIONS, from, to);
}

export function canTransitionSchedule(from: ScheduleState, to: ScheduleState): boolean {
  return can(SCHEDULE_TRANSITIONS, from, to);
}

export function canTransitionExecution(from: ExecutionState, to: ExecutionState): boolean {
  return can(EXECUTION_TRANSITIONS, from, to);
}

export function canTransitionBrowserSession(
  from: BrowserSessionState,
  to: BrowserSessionState
): boolean {
  return can(BROWSER_SESSION_TRANSITIONS, from, to);
}

export function assertTransitionExecution(from: ExecutionState, to: ExecutionState): void {
  if (!canTransitionExecution(from, to)) {
    throw new Error(`Invalid execution transition: ${from} -> ${to}`);
  }
}

export function isTerminalExecutionState(state: ExecutionState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}
