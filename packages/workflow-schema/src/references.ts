import { extractTemplateRefs } from "@app/shared";
import type { Step } from "./step";

export interface AvailableValues {
  variables: string[];
  credentials: string[];
}

export interface MissingReference {
  kind: "variables" | "credentials";
  name: string;
  /** Steps that reference it, by name, so the user knows where to look. */
  steps: string[];
}

/**
 * Finds template references a workflow makes to variables or credentials that do
 * not exist.
 *
 * Without this check a deleted credential only surfaces halfway through a run —
 * after a browser has been started and earlier steps have already had an effect
 * on the target site — and for a scheduled run nobody is watching when it happens.
 */
export function findMissingReferences(steps: Step[], available: AvailableValues): MissingReference[] {
  const known = {
    variables: new Set(available.variables),
    credentials: new Set(available.credentials)
  };
  const missing = new Map<string, MissingReference>();

  for (const step of steps) {
    if (!step.enabled || !step.value) continue;
    for (const ref of extractTemplateRefs(step.value)) {
      if (known[ref.kind].has(ref.key)) continue;
      const id = `${ref.kind}.${ref.key}`;
      const entry = missing.get(id) ?? { kind: ref.kind, name: ref.key, steps: [] };
      if (!entry.steps.includes(step.name)) entry.steps.push(step.name);
      missing.set(id, entry);
    }
  }
  return [...missing.values()];
}

/** Human readable summary, suitable for an API error or an execution log. */
export function describeMissingReferences(missing: MissingReference[]): string {
  return missing
    .map(
      (m) =>
        `{{${m.kind}.${m.name}}} is not defined (used by ${m.steps.map((s) => `'${s}'`).join(", ")})`
    )
    .join("; ");
}
