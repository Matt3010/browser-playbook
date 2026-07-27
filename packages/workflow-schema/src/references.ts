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
  return collectReferences(steps, (ref) => !known[ref.kind].has(ref.key));
}

/**
 * Finds references to values that exist but hold nothing.
 *
 * A name is created as soon as a step mentions it, so that it shows up ready to
 * be filled in — which means "it exists" stopped being proof that there is
 * anything to type. An empty secret typed into a login form is a failed attempt
 * against the real site, and enough of them lock the account, so it is refused
 * exactly like a missing one.
 */
export function findEmptyReferences(steps: Step[], empty: AvailableValues): MissingReference[] {
  return collectReferences(steps, (ref) =>
    (ref.kind === "variables" ? empty.variables : empty.credentials).includes(ref.key)
  );
}

function collectReferences(
  steps: Step[],
  matches: (ref: { kind: "variables" | "credentials"; key: string }) => boolean
): MissingReference[] {
  const found = new Map<string, MissingReference>();
  for (const step of steps) {
    if (!step.enabled || !step.value) continue;
    for (const ref of extractTemplateRefs(step.value)) {
      if (!matches(ref)) continue;
      const id = `${ref.kind}.${ref.key}`;
      const entry = found.get(id) ?? { kind: ref.kind, name: ref.key, steps: [] };
      if (!entry.steps.includes(step.name)) entry.steps.push(step.name);
      found.set(id, entry);
    }
  }
  return [...found.values()];
}

/** Human readable summary of references that exist but hold nothing. */
export function describeEmptyReferences(empty: MissingReference[]): string {
  return empty
    .map(
      (m) =>
        `{{${m.kind}.${m.name}}} is empty (used by ${m.steps.map((s) => `'${s}'`).join(", ")})`
    )
    .join("; ");
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
