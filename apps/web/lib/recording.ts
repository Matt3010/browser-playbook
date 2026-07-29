import type { Step } from "@/lib/api";

/**
 * Brings a fresh recording into the list the editor is holding.
 *
 * The recorder owns a step until the user touches it: what it recorded wins,
 * because it is watching the page and the editor is not — but a step the user
 * changed keeps their version, a step they deleted never comes back, and steps
 * they added by hand (a wait, an assertion) stay where they put them.
 *
 * All of it rests on the ids being stable across reads, which is why the worker
 * gives a recorded action its identity once, when it records it.
 */
export function mergeRecording(
  incoming: Step[],
  local: Step[],
  memory: { lastPulled: Map<string, Step>; removed: Set<string> }
): Step[] {
  const incomingById = new Map(incoming.map((step) => [step.id, step]));
  const merged: Step[] = [];

  for (const mine of local) {
    if (memory.removed.has(mine.id)) continue;
    const fresh = incomingById.get(mine.id);
    if (!fresh) {
      // Added by hand, or recorded before this page was opened: it is the
      // user's, and the recorder has nothing to say about it.
      merged.push(mine);
      continue;
    }
    const pulled = memory.lastPulled.get(mine.id);
    const touched = pulled ? JSON.stringify(pulled) !== JSON.stringify(mine) : false;
    merged.push(touched ? mine : fresh);
  }

  for (const step of incoming) {
    if (memory.removed.has(step.id)) continue;
    if (!local.some((mine) => mine.id === step.id)) merged.push(step);
  }

  return merged;
}
