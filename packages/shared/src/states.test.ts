import { describe, expect, it } from "vitest";
import {
  canTransitionWorkflow,
  canTransitionSchedule,
  canTransitionExecution,
  canTransitionBrowserSession,
  assertTransitionExecution,
  isTerminalExecutionState
} from "./states";

describe("state transitions", () => {
  it("allows valid workflow transitions", () => {
    expect(canTransitionWorkflow("draft", "ready")).toBe(true);
    expect(canTransitionWorkflow("ready", "disabled")).toBe(true);
  });

  it("allows valid schedule transitions and blocks terminal ones", () => {
    expect(canTransitionSchedule("scheduled", "queued")).toBe(true);
    expect(canTransitionSchedule("scheduled", "cancelled")).toBe(true);
    expect(canTransitionSchedule("queued", "completed")).toBe(true);
    expect(canTransitionSchedule("cancelled", "queued")).toBe(false);
    expect(canTransitionSchedule("completed", "scheduled")).toBe(false);
  });

  it("enforces the execution lifecycle", () => {
    expect(canTransitionExecution("queued", "starting")).toBe(true);
    expect(canTransitionExecution("starting", "running")).toBe(true);
    expect(canTransitionExecution("running", "completed")).toBe(true);
    expect(canTransitionExecution("running", "failed")).toBe(true);
    expect(canTransitionExecution("completed", "running")).toBe(false);
    expect(canTransitionExecution("failed", "completed")).toBe(false);
    expect(canTransitionExecution("queued", "completed")).toBe(false);
  });

  it("throws on an invalid execution transition", () => {
    expect(() => assertTransitionExecution("completed", "running")).toThrow(
      /Invalid execution transition/
    );
    expect(() => assertTransitionExecution("running", "completed")).not.toThrow();
  });

  it("enforces the browser session lifecycle", () => {
    expect(canTransitionBrowserSession("creating", "ready")).toBe(true);
    expect(canTransitionBrowserSession("ready", "running")).toBe(true);
    expect(canTransitionBrowserSession("running", "closed")).toBe(true);
    expect(canTransitionBrowserSession("closed", "ready")).toBe(false);
  });

  it("identifies terminal execution states", () => {
    expect(isTerminalExecutionState("completed")).toBe(true);
    expect(isTerminalExecutionState("failed")).toBe(true);
    expect(isTerminalExecutionState("cancelled")).toBe(true);
    expect(isTerminalExecutionState("running")).toBe(false);
  });
});
