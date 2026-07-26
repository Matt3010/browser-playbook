import { describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import {
  StepSchema,
  validateStep,
  validateSteps,
  validateFinalStepPlacement,
  findFinalStep,
  isRunnableStepList,
  type Step
} from "./step";

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

  it("defaults isFinal to false", () => {
    const parsed = StepSchema.parse(step({ type: "goto", value: "https://example.com" }));
    expect(parsed.isFinal).toBe(false);
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

describe("closing action placement", () => {
  const goto = () => StepSchema.parse(step({ type: "goto", value: "https://example.com" }));
  const click = (isFinal = false, enabled = true) =>
    StepSchema.parse(step({ type: "click", selector: labelSelector, isFinal, enabled }));

  it("accepts a closing action as the last step", () => {
    const steps = [goto(), click(true)];
    expect(validateFinalStepPlacement(steps)).toEqual([]);
    expect(validateSteps(steps).valid).toBe(true);
  });

  it("accepts a list without any closing action", () => {
    expect(validateFinalStepPlacement([goto(), click()])).toEqual([]);
  });

  it("rejects a closing action in the middle of the flow", () => {
    const steps = [goto(), click(true), click()];
    const errors = validateFinalStepPlacement(steps);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/must be the last enabled step/);
    expect(validateSteps(steps).valid).toBe(false);
  });

  it("rejects more than one closing action", () => {
    const errors = validateFinalStepPlacement([click(true), click(true)]);
    expect(errors.join(" ")).toMatch(/only one closing action is allowed/);
  });

  it("ignores disabled steps when deciding what is last", () => {
    const steps = [goto(), click(true), click(false, false)];
    expect(validateFinalStepPlacement(steps)).toEqual([]);
  });

  it("does not constrain a disabled closing action", () => {
    const steps = [goto(), click(true, false), click()];
    expect(validateFinalStepPlacement(steps)).toEqual([]);
  });

  it("finds the closing action", () => {
    const final = click(true);
    expect(findFinalStep([goto(), final])).toBe(final);
    expect(findFinalStep([goto(), click()])).toBeUndefined();
  });
});

describe("closing action placement on unparsed input", () => {
  // validateSteps receives raw JSON from the API, where optional fields may be
  // absent. Placement must be decided on values after defaults are applied,
  // otherwise a step that omits `enabled` looks disabled and the invariant is
  // bypassed.
  it("rejects a closing action followed by a step that omits enabled", () => {
    const result = validateSteps([
      {
        id: randomUUID(),
        type: "click",
        name: "Azione finale",
        selector: labelSelector,
        timeoutMs: 10000,
        isFinal: true
      },
      {
        id: randomUUID(),
        type: "click",
        name: "Step successivo senza enabled",
        selector: labelSelector,
        timeoutMs: 10000
      }
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/must be the last enabled step/);
  });

  it("rejects two closing actions given as raw input", () => {
    const raw = (name: string) => ({
      id: randomUUID(),
      type: "click",
      name,
      selector: labelSelector,
      timeoutMs: 10000,
      isFinal: true
    });
    const result = validateSteps([raw("Prima finale"), raw("Seconda finale")]);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/only one closing action/);
  });
});

describe("placeholders that are not references", () => {
  // A mistyped reference used to survive validation and be typed into the page as
  // literal text. Refusing it at save time is the only moment the user is watching.
  const fill = (value: string) => ({
    id: "00000000-0000-4000-8000-000000000001",
    type: "fill",
    name: "Inserisci la password",
    pageId: "main",
    selector: { strategy: "id", value: "password", pageId: "main" },
    value,
    timeoutMs: 15000
  });

  it("refuses a value naming a kind that does not exist", () => {
    const result = validateSteps([fill("{{secret.password}}")]);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/secret\.password/);
  });

  it("accepts the real reference kinds", () => {
    expect(validateSteps([fill("{{credentials.password}}")]).valid).toBe(true);
    expect(validateSteps([fill("{{ variables.email }}")]).valid).toBe(true);
  });

  it("leaves a plain value alone", () => {
    expect(validateSteps([fill("TestPassword123!")]).valid).toBe(true);
  });
});
