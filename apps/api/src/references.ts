import type { FastifyInstance } from "fastify";
import { decryptSecret } from "@app/shared";
import {
  describeEmptyReferences,
  describeMissingReferences,
  findEmptyReferences,
  findMissingReferences,
  type Step
} from "@app/workflow-schema";

/**
 * What a workflow may reference, and what it may not rely on yet.
 *
 * A name exists as soon as a step mentions it — the editor creates it empty so
 * it shows up ready to be filled in — so "it exists" is no longer proof that
 * there is anything to type. Both states are refused before a browser is
 * started: an empty secret sent to a login form is a failed attempt against the
 * real site, and enough of them lock the account.
 *
 * One place, because the immediate-run route, the scheduling route and the
 * runner have to answer this question the same way.
 */
export interface ReferenceState {
  available: { variables: string[]; credentials: string[] };
  empty: { variables: string[]; credentials: string[] };
}

export async function referenceState(
  app: FastifyInstance,
  userId: string
): Promise<ReferenceState> {
  const rows = await app.prisma.credential.findMany({
    where: { userId },
    select: { name: true, kind: true, encryptedValue: true }
  });
  const state: ReferenceState = {
    available: { variables: [], credentials: [] },
    empty: { variables: [], credentials: [] }
  };
  for (const row of rows) {
    const bucket = row.kind === "secret" ? "credentials" : "variables";
    state.available[bucket].push(row.name);
    let value = "";
    try {
      value = decryptSecret(row.encryptedValue, app.config.credentialsEncKey);
    } catch {
      // A value that cannot be decrypted is a value nothing can type: treat it
      // as empty rather than letting the run discover it halfway through.
    }
    if (value.length === 0) state.empty[bucket].push(row.name);
  }
  return state;
}

/** The reason a workflow cannot run yet, or null when every reference resolves. */
export function unresolvedReferences(
  steps: Step[],
  state: ReferenceState
): { error: string; missingReferences: ReturnType<typeof findMissingReferences> } | null {
  const missing = findMissingReferences(steps, state.available);
  if (missing.length > 0) {
    return {
      error: `The workflow references values that do not exist: ${describeMissingReferences(missing)}`,
      missingReferences: missing
    };
  }
  const empty = findEmptyReferences(steps, state.empty);
  if (empty.length > 0) {
    return {
      error: `The workflow references values that are empty: ${describeEmptyReferences(empty)}`,
      missingReferences: empty
    };
  }
  return null;
}
