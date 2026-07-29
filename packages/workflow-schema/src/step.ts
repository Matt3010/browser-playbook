import { z } from "zod";
import { findUnknownPlaceholders } from "@app/shared";
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
  "upload",
  "read"
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
  "upload",
  "read"
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
    /**
     * Origin of the document this step was recorded against.
     *
     * Page ids are handed out in the order tabs appear, so `tab-1` means "the first
     * tab that opened" rather than a particular document: a tab the recording never
     * saw shifts the numbering and the id then names something else. Carrying the
     * origin lets the runner tell the two apart instead of acting on whatever bears
     * the number. Null on steps recorded before this existed, and on `main`, whose
     * identity is never in question.
     */
    pageOrigin: z.string().nullish(),
    selector: SelectorSchema.nullish(),
    value: z.string().nullish(),
    timeoutMs: z.number().int().min(100).max(120000).default(10000),
    enabled: z.boolean().default(true),
    /**
     * The name a `read` step files its result under.
     *
     * Its own field rather than `value`: `value` is a template — it is rendered,
     * checked for unknown placeholders, and shown in the editor as the thing a
     * step would type. A name is none of those.
     */
    outputName: z
      .string()
      .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, "outputName may only contain letters, digits and underscores")
      .max(100)
      .nullish(),
    /**
     * A closing action that was recorded without being performed: the recorder
     * captured the interaction and suppressed it, so nothing happened on the site
     * while recording. It runs only when the workflow runs.
     *
     * It must be the last enabled step. Anything after it would depend on the
     * effect of an action that was never observed during recording.
     */
    isFinal: z.boolean().default(false)
  })
  .superRefine((step, ctx) => {
    if (step.type === "read" && !step.outputName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outputName"],
        message: "step type 'read' requires an output name: it is how the result is referred to"
      });
    }
    if (step.type !== "read" && step.outputName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outputName"],
        message: `only a 'read' step may carry an output name, not '${step.type}'`
      });
    }
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
    if (step.value) {
      // renderTemplate only substitutes what it recognises, so a mistyped reference
      // would be typed into the page verbatim. Refused here, where the user is
      // still looking at the step.
      const unknown = findUnknownPlaceholders(step.value);
      if (unknown.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["value"],
          message:
            `${unknown.join(", ")} is not a valid reference: use ` +
            "{{credentials.name}} for a secret or {{variables.name}} for a value"
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
  if (errors.length === 0) {
    // Placement depends on `enabled` and `isFinal`, which are optional in the raw
    // payload. Validating before defaults are applied would let a step that omits
    // `enabled` look disabled and slip past the invariant.
    const parsed = input.map((step) => StepSchema.parse(step));
    errors.push(...validateFinalStepPlacement(parsed));
    errors.push(...validateUniqueOutputNames(parsed));
  }
  return { valid: errors.length === 0, errors };
}

/**
 * A closing action recorded without being executed can only sit at the end of the
 * workflow, and there can be only one: it is the action whose effect nobody
 * observed while recording, so nothing may depend on it.
 */
export function validateFinalStepPlacement(steps: Step[]): string[] {
  const errors: string[] = [];
  const finals = steps.filter((s) => s.isFinal);
  if (finals.length === 0) return errors;

  if (finals.length > 1) {
    errors.push(
      `only one closing action is allowed, found ${finals.length}: ` +
        finals.map((s) => `'${s.name}'`).join(", ")
    );
  }

  for (const final of finals) {
    if (!final.enabled) continue;
    const index = steps.indexOf(final);
    const followedBy = steps.slice(index + 1).filter((s) => s.enabled);
    if (followedBy.length > 0) {
      errors.push(
        `the closing action '${final.name}' must be the last enabled step, ` +
          `but ${followedBy.length} enabled step(s) follow it`
      );
    }
  }
  return errors;
}

/**
 * Two live reads may not file their results under one name.
 *
 * A workflow may read as many things as it likes — that is the point — but two
 * results called the same thing cannot be told apart afterwards by anything: not
 * a comparison, not a notification, not a person reading the list. A disabled
 * read does not conflict: it produces nothing.
 */
export function validateUniqueOutputNames(steps: Step[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const step of steps) {
    if (step.type !== "read" || !step.enabled || !step.outputName) continue;
    if (seen.has(step.outputName)) {
      errors.push(
        `two enabled steps read into '${step.outputName}': give one of them another name`
      );
      continue;
    }
    seen.add(step.outputName);
  }
  return errors;
}

/** The closing action of a step list, when it has one. */
export function findFinalStep(steps: Step[]): Step | undefined {
  return steps.find((s) => s.isFinal);
}

/** A workflow is runnable only when it has at least one enabled step. */
export function isRunnableStepList(steps: Step[]): boolean {
  return steps.some((s) => s.enabled);
}

/**
 * The shape a step has in the database.
 *
 * Five places used to translate between a row and a `Step` by hand — two in the
 * workflow routes, one in the clone route, one where an execution re-parses the
 * steps, one in the worker. A field added to the schema and forgotten in one of
 * them disappears on that path alone, silently, which is the first defect class
 * this codebase ever produced. There is one translation now.
 */
export interface StepRow {
  id: string;
  type: string;
  name: string;
  pageId: string;
  pageOrigin: string | null;
  selectorJson: unknown;
  valueTemplate: string | null;
  outputName: string | null;
  timeoutMs: number;
  enabled: boolean;
  isFinal: boolean;
}

export function stepFromRow(row: StepRow): Step {
  return StepSchema.parse({
    id: row.id,
    type: row.type,
    name: row.name,
    pageId: row.pageId,
    pageOrigin: row.pageOrigin,
    selector: row.selectorJson ?? null,
    value: row.valueTemplate,
    outputName: row.outputName,
    timeoutMs: row.timeoutMs,
    enabled: row.enabled,
    isFinal: row.isFinal
  });
}

/** The same translation the other way, for writing a step back to its row. */
export function stepToRow(step: Step, position: number): Omit<StepRow, "selectorJson"> & {
  position: number;
  selectorJson: unknown;
} {
  return {
    id: step.id,
    position,
    type: step.type,
    name: step.name,
    pageId: step.pageId,
    pageOrigin: step.pageOrigin ?? null,
    selectorJson: (step.selector ?? null) as unknown,
    valueTemplate: step.value ?? null,
    outputName: step.outputName ?? null,
    timeoutMs: step.timeoutMs,
    enabled: step.enabled,
    isFinal: step.isFinal
  };
}
