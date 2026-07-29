import { z } from "zod";
import {
  chooseSelector,
  describeSelector,
  looksVolatile,
  type ElementInfo,
  type Selector
} from "./selector";
import { StepSchema, type Step, type StepType } from "./step";

export const RECORDED_ACTION_KINDS = [
  "navigate",
  "click",
  "fill",
  "select",
  "check",
  "uncheck",
  "press",
  "submit",
  "newTab",
  "switchTab",
  "download",
  "upload",
  "wait"
] as const;

export type RecordedActionKind = (typeof RECORDED_ACTION_KINDS)[number];

export const ElementInfoSchema = z.object({
  tag: z.string(),
  type: z.string().nullish(),
  role: z.string().nullish(),
  accessibleName: z.string().nullish(),
  label: z.string().nullish(),
  placeholder: z.string().nullish(),
  text: z.string().nullish(),
  testId: z.string().nullish(),
  nameAttr: z.string().nullish(),
  valueAttr: z.string().nullish(),
  id: z.string().nullish(),
  cssPath: z.string().nullish(),
  xpath: z.string().nullish(),
  unique: z.record(z.boolean()).nullish(),
  pageId: z.string().nullish(),
  frame: z.string().nullish()
});

export const RecordedActionSchema = z.object({
  /**
   * Identity of the action, assigned when it is recorded and carried into the
   * step it becomes.
   *
   * The editor polls the recording while it runs, so the step list is read many
   * times over. Minting fresh ids on every read made it a different list each
   * second: an open form lost the step it was editing, and anything the user did
   * to the list — a deletion above all — was undone by the next poll.
   */
  id: z.string().nullish(),
  kind: z.enum(RECORDED_ACTION_KINDS),
  element: ElementInfoSchema.nullish(),
  url: z.string().nullish(),
  value: z.string().nullish(),
  key: z.string().nullish(),
  /** True when the source input was type="password": the value becomes a credential. */
  isPassword: z.boolean().nullish(),
  /**
   * URL of the page the action happened on. Used to name a captured credential
   * after the site, so two sites never share one secret.
   */
  pageUrl: z.string().nullish(),
  /**
   * True when the interaction was captured while the recorder was armed for a
   * closing action: it was suppressed in the page and must run only at execution
   * time, as the last step of the workflow.
   */
  isFinal: z.boolean().nullish(),
  pageId: z.string().default("main"),
  timestamp: z.number()
});

export type RecordedAction = z.infer<typeof RecordedActionSchema>;

const KIND_TO_STEP_TYPE: Record<RecordedActionKind, StepType | null> = {
  navigate: "goto",
  click: "click",
  fill: "fill",
  select: "select",
  check: "check",
  uncheck: "uncheck",
  press: "press",
  submit: "click",
  newTab: "switchPage",
  switchTab: "switchPage",
  download: "download",
  upload: "upload",
  wait: "wait"
};

/**
 * A step name is only a label, but one minted from a price starts lying the moment
 * the price moves, and the operator cannot tell whether the step is stale or the
 * page changed. Past this length a label is page copy rather than a name.
 */
const MAX_STEP_NAME_LENGTH = 60;

/** Connectives left dangling when a name is cut before a price. */
const DANGLING_WORDS = /^(da|a|o|e|di|per|al|alla|con|su|in|the|from|to|or|and|of|for|at)$/i;

/**
 * Drops everything from the first volatile fragment onwards, so `15" Nota 1 Da
 * € 1.749,00 o € 57,26 al mese` becomes `15" Nota 1`: the part that identifies the
 * option survives, the part that changes with the price does not.
 */
function cutBeforeVolatile(text: string): string | null {
  const kept: string[] = [];
  for (const word of text.split(" ")) {
    if (looksVolatile(word)) break;
    kept.push(word);
  }
  while (kept.length > 0 && DANGLING_WORDS.test(kept[kept.length - 1] as string)) kept.pop();
  const result = kept.join(" ").trim();
  return result.length > 1 ? result : null;
}

/** Text fit to name a step: no volatile fragment, no wall of page copy. */
function stableText(value: string | null | undefined): string | null {
  const text = value?.trim().replace(/\s+/g, " ");
  if (!text) return null;
  const stable = looksVolatile(text) ? cutBeforeVolatile(text) : text;
  if (!stable) return null;
  return stable.length > MAX_STEP_NAME_LENGTH
    ? `${stable.slice(0, MAX_STEP_NAME_LENGTH - 1).trimEnd()}…`
    : stable;
}

function labelFor(element: ElementInfo | null | undefined): string {
  if (!element) return "elemento";
  // The value attribute names the option a grouped input stands for, and unlike a
  // label it cannot carry a price. It is only read for inputs whose value is a
  // fixed choice, never for a field the user types into.
  const choiceValue =
    element.type === "radio" || element.type === "checkbox" ? element.valueAttr : null;
  return (
    stableText(element.label) ||
    stableText(element.accessibleName) ||
    stableText(element.placeholder) ||
    stableText(choiceValue) ||
    stableText(element.nameAttr) ||
    stableText(element.text) ||
    stableText(element.id) ||
    element.tag.toLowerCase()
  );
}

function stepName(action: RecordedAction, selector: Selector | null): string {
  const target = labelFor(action.element) || (selector ? describeSelector(selector) : "elemento");
  switch (action.kind) {
    case "navigate":
      return `Vai a ${action.url ?? ""}`.trim();
    case "click":
    case "submit":
      return `Clicca ${target}`;
    case "fill":
      return `Inserisci ${target}`;
    case "select":
      return `Seleziona ${target}`;
    case "check":
      return `Seleziona casella ${target}`;
    case "uncheck":
      return `Deseleziona casella ${target}`;
    case "press":
      return `Premi ${action.key ?? action.value ?? "tasto"}`;
    case "newTab":
      return `Passa alla nuova tab ${action.value ?? ""}`.trim();
    case "switchTab":
      return `Passa alla tab ${action.value ?? ""}`.trim();
    case "download":
      return `Scarica file da ${target}`;
    case "upload":
      return `Carica file su ${target}`;
    case "wait":
      return `Attendi ${action.value ?? 0} ms`;
    default:
      return "Step";
  }
}

function slugify(value: string): string {
  return value
    .toString()
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

/**
 * The site a credential belongs to, as a slug. The port is dropped and a `www.`
 * prefix ignored: neither is part of the site's identity, and including them
 * would create a second credential for the same login.
 */
/**
 * Origin of the page an action was recorded on, when it is one that identifies a
 * document. A tab captured the instant it opens is still `about:blank`, which
 * identifies nothing, so it yields null and no check is made for that step.
 */
export function originOfRecordedPage(pageUrl: string | null | undefined): string | null {
  if (!pageUrl) return null;
  try {
    const origin = new URL(pageUrl).origin;
    return origin && origin !== "null" ? origin : null;
  } catch {
    return null;
  }
}

export function siteSlugFromUrl(pageUrl: string | null | undefined): string | null {
  if (!pageUrl) return null;
  let host: string;
  try {
    const parsed = new URL(pageUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    host = parsed.hostname.replace(/^www\./i, "");
  } catch {
    return null;
  }
  const slug = slugify(host);
  return slug.length > 0 ? slug : null;
}

/**
 * Derives a credential name from the recorded password field *and* the site.
 *
 * Naming it after the field alone is not enough: every login form calls it
 * `password`, so recording a second site would overwrite the first site's secret
 * and leave the first workflow signing in with the wrong password.
 */
export function credentialNameFromElement(
  element: ElementInfo | null | undefined,
  pageUrl?: string | null
): string {
  const raw = element?.nameAttr || element?.id || element?.label || element?.placeholder || "password";
  const field = slugify(raw) || "password";
  const site = siteSlugFromUrl(pageUrl);
  return site ? `${field}_${site}` : field;
}

export interface ActionConversion {
  step: Step;
  /** Set when the action produced a credential reference that must be stored. */
  credential?: { name: string; value: string };
}

export interface ConvertOptions {
  defaultTimeoutMs?: number;
  newId?: () => string;
}

function newUuid(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Converts one recorded action into a structured step.
 * Returns null when the action cannot be expressed unambiguously (for example a
 * click on an element for which no unique selector exists) — the caller must
 * surface that to the user instead of recording a guess.
 */
export function actionToStep(
  action: RecordedAction,
  opts: ConvertOptions = {}
): ActionConversion | null {
  const timeoutMs = opts.defaultTimeoutMs ?? 10000;
  const newId = opts.newId ?? newUuid;
  const type = KIND_TO_STEP_TYPE[action.kind];
  if (!type) return null;

  let selector: Selector | null = null;
  if (action.element) {
    selector = chooseSelector({
      ...action.element,
      pageId: action.element.pageId ?? action.pageId,
      frame: action.element.frame ?? null
    });
  }

  const needsSelector = ["click", "fill", "select", "check", "uncheck", "download", "upload"].includes(
    type
  );
  if (needsSelector && !selector) {
    return null;
  }

  let value: string | null = null;
  let credential: ActionConversion["credential"];

  switch (action.kind) {
    case "navigate":
      value = action.url ?? null;
      break;
    case "press":
      value = action.key ?? action.value ?? null;
      break;
    case "newTab":
    case "switchTab":
      value = action.value ?? "main";
      break;
    case "wait":
      value = action.value ?? "1000";
      break;
    case "fill": {
      if (action.isPassword) {
        const name = credentialNameFromElement(action.element, action.pageUrl);
        value = `{{credentials.${name}}}`;
        credential = { name, value: action.value ?? "" };
      } else {
        value = action.value ?? "";
      }
      break;
    }
    case "select":
    case "upload":
      value = action.value ?? "";
      break;
    case "download":
      // The suggested filename is informational: it is kept so the editor and
      // the execution log can show which file the step is expected to produce.
      value = action.value ?? null;
      break;
    default:
      value = null;
  }

  const parsed = StepSchema.safeParse({
    // The action's own id when it has one, so the same action is the same step
    // every time the recording is read.
    id: action.id ?? newId(),
    type,
    name: action.isFinal
      ? `${stepName(action, selector)} (azione finale)`
      : stepName(action, selector),
    pageId: action.pageId,
    // Which document this was recorded against, so the runner can tell a tab from
    // another one that merely inherited its number. about:blank and anything
    // unparseable carry no identity and are left out.
    pageOrigin: originOfRecordedPage(action.pageUrl),
    selector,
    value,
    timeoutMs,
    enabled: true,
    isFinal: action.isFinal === true
  });

  if (!parsed.success) return null;
  return { step: parsed.data, credential };
}

function sameTarget(a: Step, b: Step): boolean {
  if (!a.selector || !b.selector) return false;
  return (
    a.selector.strategy === b.selector.strategy &&
    a.selector.value === b.selector.value &&
    a.selector.role === b.selector.role &&
    a.selector.name === b.selector.name &&
    a.pageId === b.pageId
  );
}

export interface ConversionResult {
  steps: Step[];
  credentials: Array<{ name: string; value: string }>;
  /** Actions that could not be converted (ambiguous selector, unsupported kind). */
  skipped: RecordedAction[];
  /**
   * Index of the action each step came from, aligned with `steps`. Needed to line
   * per-action results (such as a selector check) up with what the user sees,
   * since fills collapse and repeated navigations are dropped.
   */
  sourceActionIndex: number[];
}

/**
 * Converts a recorded action stream into an ordered step list.
 * Consecutive fills on the same field collapse into the final value, and
 * repeated navigations to the same URL are de-duplicated.
 */
export function actionsToSteps(
  actions: RecordedAction[],
  opts: ConvertOptions = {}
): ConversionResult {
  const steps: Step[] = [];
  const credentials: Array<{ name: string; value: string }> = [];
  const skipped: RecordedAction[] = [];
  const sourceActionIndex: number[] = [];

  for (const [actionIndex, action] of actions.entries()) {
    const converted = actionToStep(action, opts);
    if (!converted) {
      skipped.push(action);
      continue;
    }
    const { step, credential } = converted;

    const previous = steps[steps.length - 1];
    if (
      previous &&
      step.type === "fill" &&
      previous.type === "fill" &&
      sameTarget(previous, step)
    ) {
      steps[steps.length - 1] = { ...previous, value: step.value, name: step.name };
      sourceActionIndex[sourceActionIndex.length - 1] = actionIndex;
    } else if (
      previous &&
      step.type === "goto" &&
      previous.type === "goto" &&
      previous.value === step.value
    ) {
      // duplicate navigation, ignore
    } else {
      steps.push(step);
      sourceActionIndex.push(actionIndex);
    }

    if (credential) {
      const existing = credentials.findIndex((c) => c.name === credential.name);
      if (existing >= 0) credentials[existing] = credential;
      else credentials.push(credential);
    }
  }

  return { steps, credentials, skipped, sourceActionIndex };
}
