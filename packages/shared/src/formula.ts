/**
 * Formulas inside a variable's value.
 *
 * A workflow that repeats hits the same wall every time: the site it acts on
 * wants something new. A repository name, an order reference, a ticket
 * title — the second run fails with "already exists" and the schedule quietly
 * becomes a nightly failure. A variable holding `test-{{timestamp}}` instead of
 * `test` is what makes the run survive its own repetition.
 *
 * The formula lives in the *variable*, not in the step: the step keeps saying
 * `{{variables.repoName}}`, which is what the recorder wrote and what the editor
 * shows, and only what that name stands for changes from run to run.
 *
 * Evaluated once per run: a name typed into a field and then searched for again
 * must be the same name both times, so every reference to one variable inside a
 * single execution renders identically.
 */

/** What a formula needs from the world, injected so it can be tested. */
export interface FormulaEnvironment {
  now: Date;
  /** Returns a random number in [0, 1), like `Math.random`. */
  random: () => number;
  uuid: () => string;
}

const TOKEN_RE = /\{\{\s*(timestamp|date|time|uuid|random)(?::([a-zA-Z0-9_-]{1,20}))?\s*\}\}/g;

/** The tokens a formula may use, for the interface to list them. */
export const FORMULA_TOKENS = [
  { token: "{{timestamp}}", describes: "20260728-113045" },
  { token: "{{date}}", describes: "2026-07-28" },
  { token: "{{time}}", describes: "11:30:45" },
  { token: "{{random}}", describes: "sei caratteri casuali" },
  { token: "{{random:10}}", describes: "dieci caratteri casuali" },
  { token: "{{uuid}}", describes: "un identificatore unico" }
] as const;

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/**
 * UTC, deliberately: the same formula must produce the same shape wherever it
 * runs, and a name that carries the hour of a machine nobody looks at is a name
 * whose collisions come back at the worst moment.
 */
function parts(now: Date) {
  return {
    year: now.getUTCFullYear(),
    month: pad(now.getUTCMonth() + 1),
    day: pad(now.getUTCDate()),
    hour: pad(now.getUTCHours()),
    minute: pad(now.getUTCMinutes()),
    second: pad(now.getUTCSeconds())
  };
}

function randomText(length: number, random: () => number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[Math.floor(random() * ALPHABET.length)];
  }
  return out;
}

/** True when the text contains at least one formula token. */
export function hasFormula(input: string): boolean {
  return new RegExp(TOKEN_RE.source).test(input);
}

export function evaluateFormula(input: string, env: FormulaEnvironment): string {
  const p = parts(env.now);
  return input.replace(TOKEN_RE, (_match, name: string, arg?: string) => {
    switch (name) {
      case "timestamp":
        return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}`;
      case "date":
        return `${p.year}-${p.month}-${p.day}`;
      case "time":
        return `${p.hour}:${p.minute}:${p.second}`;
      case "uuid":
        return env.uuid();
      case "random": {
        const length = arg ? Number(arg) : 6;
        // An argument that is not a length is not a reason to fail a run that
        // was going to work: it falls back to the default rather than throwing.
        const size = Number.isFinite(length) && length >= 1 && length <= 64 ? length : 6;
        return randomText(size, env.random);
      }
      default:
        return _match;
    }
  });
}

/** The environment a real run uses. */
export function liveEnvironment(): FormulaEnvironment {
  return {
    now: new Date(),
    random: Math.random,
    uuid: () => globalThis.crypto.randomUUID()
  };
}

/**
 * Evaluates every value that carries a formula, once.
 *
 * Once, because two steps referring to the same variable must type the same
 * text: a repository created under one name and then opened under another is
 * two different failures, and the second one is the confusing kind.
 */
export function evaluateFormulas(
  values: Record<string, string>,
  env: FormulaEnvironment = liveEnvironment()
): Record<string, string> {
  const evaluated: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    evaluated[name] = hasFormula(value) ? evaluateFormula(value, env) : value;
  }
  return evaluated;
}
