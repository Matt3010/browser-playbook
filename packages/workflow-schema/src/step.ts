import { z } from "zod";
import { SelectorSchema } from "./selector";

export const STEP_TYPES = [
  "goto",
  "click",
  "fill",
  "select",
  "check",
  "uncheck",
  "press",
  "wait",
  "waitForElement",
  "assertVisible",
  "assertText",
  "switchPage",
  "download",
  "upload"
] as const;

export type StepType = (typeof STEP_TYPES)[number];

/** Step types that must target an element through a selector. */
export const SELECTOR_REQUIRED_TYPES: StepType[] = [
  "click",
  "fill",
  "select",
  "check",
  "uncheck",
  "waitForElement",
  "assertVisible",
  "assertText",
  "download",
  "upload"
];

/** Step types that must carry a value (possibly a template). */
export const VALUE_REQUIRED_TYPES: StepType[] = [
  "goto",
  "fill",
  "select",
  "press",
  "wait",
  "assertText",
  "switchPage",
  "upload"
];

export const StepSchema = z
  .object({
    id: z.string().uuid(),
    type: z.enum(STEP_TYPES),
    name: z.string().min(1).max(200),
    pageId: z.string().min(1).default("main"),
    selector: SelectorSchema.nullish(),
    value: z.string().nullish(),
    timeoutMs: z.number().int().min(100).max(120000).default(10000),
    enabled: z.boolean().default(true)
  })
  .superRefine((step, ctx) => {
    if (SELECTOR_REQUIRED_TYPES.includes(step.type) && !step.selector) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["selector"],
        message: `step type '${step.type}' requires a selector`
      });
    }
    if (VALUE_REQUIRED_TYPES.includes(step.type)) {
      if (step.value === null || step.value === undefined || step.value === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["value"],
          message: `step type '${step.type}' requires a value`
        });
      }
    }
    if (step.type === "goto" && step.value) {
      // Templates are resolved at run time, so only validate literal URLs here.
      if (!step.value.includes("{{") && !/^https?:\/\//i.test(step.value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["value"],
          message: "goto value must be an absolute http(s) URL"
        });
      }
    }
    if (step.type === "wait" && step.value && !step.value.includes("{{")) {
      const ms = Number(step.value);
      if (!Number.isFinite(ms) || ms < 0 || ms > 120000) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["value"],
          message: "wait value must be a duration in ms between 0 and 120000"
        });
      }
    }
  });

export type Step = z.infer<typeof StepSchema>;

export const StepListSchema = z.array(StepSchema);

export interface StepValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateStep(input: unknown): StepValidationResult {
  const parsed = StepSchema.safeParse(input);
  if (parsed.success) return { valid: true, errors: [] };
  return {
    valid: false,
    errors: parsed.error.issues.map((i) =>
      i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message
    )
  };
}

export function validateSteps(input: unknown): StepValidationResult {
  if (!Array.isArray(input)) {
    return { valid: false, errors: ["steps must be an array"] };
  }
  const errors: string[] = [];
  input.forEach((step, index) => {
    const result = validateStep(step);
    if (!result.valid) {
      errors.push(...result.errors.map((e) => `steps[${index}].${e}`));
    }
  });
  return { valid: errors.length === 0, errors };
}

/** A workflow is runnable only when it has at least one enabled step. */
export function isRunnableStepList(steps: Step[]): boolean {
  return steps.some((s) => s.enabled);
}
