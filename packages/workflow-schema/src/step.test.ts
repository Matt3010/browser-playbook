import { describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { StepSchema, validateStep, validateSteps, isRunnableStepList, type Step } from "./step";

function step(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    id: randomUUID(),
    name: "Step",
    timeoutMs: 10000,
    enabled: true,
    ...partial
  };
}

const labelSelector = { strategy: "label", value: "Email", pageId: "main" };

describe("step validation", () => {
  it("accepts a valid fill step", () => {
    const result = validateStep(
      step({ type: "fill", selector: labelSelector, value: "{{credentials.email}}" })
    );
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("defaults pageId, timeout and enabled", () => {
    const parsed = StepSchema.parse({
      id: randomUUID(),
      type: "click",
      name: "Clicca",
      selector: labelSelector
    });
    expect(parsed.pageId).toBe("main");
    expect(parsed.timeoutMs).toBe(10000);
    expect(parsed.enabled).toBe(true);
  });

  it("rejects an unknown step type", () => {
    const result = validateStep(step({ type: "evaluate", value: "alert(1)" }));
    expect(result.valid).toBe(false);
  });

  it("requires a selector for element steps", () => {
    for (const type of [
      "click",
      "check",
      "uncheck",
      "waitForElement",
      "assertVisible",
      "download"
    ]) {
      const result = validateStep(step({ type, value: type === "assertText" ? "x" : undefined }));
      expect(result.valid, type).toBe(false);
      expect(result.errors.join(" "), type).toMatch(/requires a selector/);
    }
  });

  it("requires a value for value steps", () => {
    const result = validateStep(step({ type: "fill", selector: labelSelector }));
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/requires a value/);
  });

  it("does not require a selector for goto/wait/press/switchPage", () => {
    expect(validateStep(step({ type: "goto", value: "https://example.com" })).valid).toBe(true);
    expect(validateStep(step({ type: "wait", value: "500" })).valid).toBe(true);
    expect(validateStep(step({ type: "press", value: "Enter" })).valid).toBe(true);
    expect(validateStep(step({ type: "switchPage", value: "tab-1" })).valid).toBe(true);
  });

  it("requires goto values to be absolute http(s) URLs", () => {
    expect(validateStep(step({ type: "goto", value: "/relative" })).valid).toBe(false);
    expect(validateStep(step({ type: "goto", value: "ftp://example.com" })).valid).toBe(false);
    expect(validateStep(step({ type: "goto", value: "https://example.com" })).valid).toBe(true);
  });

  it("allows templated goto and wait values", () => {
    expect(validateStep(step({ type: "goto", value: "{{variables.startUrl}}" })).valid).toBe(true);
    expect(validateStep(step({ type: "wait", value: "{{variables.delay}}" })).valid).toBe(true);
  });

  it("validates wait durations", () => {
    expect(validateStep(step({ type: "wait", value: "abc" })).valid).toBe(false);
    expect(validateStep(step({ type: "wait", value: "999999" })).valid).toBe(false);
    expect(validateStep(step({ type: "wait", value: "0" })).valid).toBe(true);
  });

  it("bounds the timeout", () => {
    expect(validateStep(step({ type: "wait", value: "10", timeoutMs: 10 })).valid).toBe(false);
    expect(validateStep(step({ type: "wait", value: "10", timeoutMs: 999999 })).valid).toBe(false);
  });

  it("rejects a non-uuid id", () => {
    expect(validateStep({ ...step({ type: "wait", value: "10" }), id: "abc" }).valid).toBe(false);
  });

  it("rejects a selector with strategy role but no role", () => {
    const result = validateStep(
      step({ type: "click", selector: { strategy: "role", name: "Login", pageId: "main" } })
    );
    expect(result.valid).toBe(false);
  });

  it("rejects a non-role selector without a value", () => {
    const result = validateStep(
      step({ type: "click", selector: { strategy: "label", pageId: "main" } })
    );
    expect(result.valid).toBe(false);
  });

  it("validates a list of steps and reports the failing index", () => {
    const result = validateSteps([
      step({ type: "goto", value: "https://example.com" }),
      step({ type: "fill", selector: labelSelector })
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/steps\[1\]/);
  });

  it("rejects a non-array step list", () => {
    expect(validateSteps({}).valid).toBe(false);
  });

  it("treats a list with no enabled step as not runnable", () => {
    const enabled = StepSchema.parse(step({ type: "goto", value: "https://example.com" })) as Step;
    const disabled = StepSchema.parse(
      step({ type: "goto", value: "https://example.com", enabled: false })
    ) as Step;
    expect(isRunnableStepList([enabled])).toBe(true);
    expect(isRunnableStepList([disabled])).toBe(false);
    expect(isRunnableStepList([])).toBe(false);
  });
});
