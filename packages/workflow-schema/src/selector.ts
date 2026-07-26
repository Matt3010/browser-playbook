import { z } from "zod";

/**
 * Selector strategies, ordered by priority. The recorder always tries to pick
 * the highest priority strategy that unambiguously identifies one element.
 */
export const SELECTOR_STRATEGIES = [
  "role",
  "label",
  "placeholder",
  "text",
  "testid",
  "name",
  "id",
  "css",
  "xpath"
] as const;

export type SelectorStrategy = (typeof SELECTOR_STRATEGIES)[number];

export const SELECTOR_PRIORITY: SelectorStrategy[] = [...SELECTOR_STRATEGIES];

export const SelectorSchema = z
  .object({
    strategy: z.enum(SELECTOR_STRATEGIES),
    /** Primary selector value. For strategy "role" this is unused; use role+name. */
    value: z.string().min(1).optional(),
    role: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    /** Raw CSS (or XPath) fallback used only when the primary selector fails. */
    fallback: z.string().min(1).nullish(),
    /** Logical page/tab identifier the element belongs to. */
    pageId: z.string().min(1).default("main"),
    /** Same-origin frame selector, when the element lives inside an iframe. */
    frame: z.string().min(1).nullish()
  })
  .superRefine((sel, ctx) => {
    if (sel.strategy === "role") {
      if (!sel.role) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "selector.role is required when strategy is 'role'"
        });
      }
    } else if (!sel.value) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `selector.value is required when strategy is '${sel.strategy}'`
      });
    }
  });

export type Selector = z.infer<typeof SelectorSchema>;

/** Raw information about a DOM element, collected by the injected recorder script. */
export interface ElementInfo {
  tag: string;
  type?: string | null;
  role?: string | null;
  accessibleName?: string | null;
  label?: string | null;
  placeholder?: string | null;
  text?: string | null;
  testId?: string | null;
  nameAttr?: string | null;
  id?: string | null;
  cssPath?: string | null;
  xpath?: string | null;
  /**
   * Per-strategy uniqueness, computed in the page: true when the candidate
   * selector matched exactly one element.
   */
  unique?: Partial<Record<SelectorStrategy, boolean>> | null;
  pageId?: string | null;
  frame?: string | null;
}

interface Candidate {
  strategy: SelectorStrategy;
  value?: string;
  role?: string;
  name?: string;
}

function isUnique(info: ElementInfo, strategy: SelectorStrategy): boolean {
  // Absence of information is treated as "not proven unique" for the
  // ambiguity-sensitive strategies, and as unique for structural ones.
  const flag = info.unique?.[strategy];
  if (typeof flag === "boolean") return flag;
  return strategy === "css" || strategy === "xpath" || strategy === "id" || strategy === "testid";
}

function buildCandidates(info: ElementInfo): Candidate[] {
  const candidates: Candidate[] = [];

  if (info.role && info.accessibleName) {
    candidates.push({ strategy: "role", role: info.role, name: info.accessibleName });
  }
  if (info.label) {
    candidates.push({ strategy: "label", value: info.label });
  }
  if (info.placeholder) {
    candidates.push({ strategy: "placeholder", value: info.placeholder });
  }
  if (info.text && info.text.trim().length > 0 && info.text.trim().length <= 80) {
    candidates.push({ strategy: "text", value: info.text.trim() });
  }
  if (info.testId) {
    candidates.push({ strategy: "testid", value: info.testId });
  }
  if (info.nameAttr) {
    candidates.push({ strategy: "name", value: info.nameAttr });
  }
  if (info.id) {
    candidates.push({ strategy: "id", value: info.id });
  }
  if (info.cssPath) {
    candidates.push({ strategy: "css", value: info.cssPath });
  }
  if (info.xpath) {
    candidates.push({ strategy: "xpath", value: info.xpath });
  }

  return candidates.sort(
    (a, b) => SELECTOR_PRIORITY.indexOf(a.strategy) - SELECTOR_PRIORITY.indexOf(b.strategy)
  );
}

/** Builds a raw CSS/XPath string usable as a fallback selector. */
export function buildFallback(info: ElementInfo): string | null {
  if (info.nameAttr) {
    return `${info.tag.toLowerCase()}[name='${info.nameAttr}']`;
  }
  if (info.id) {
    return `#${info.id}`;
  }
  if (info.cssPath) return info.cssPath;
  if (info.xpath) return info.xpath;
  return null;
}

/**
 * Picks the best selector for an element following the documented priority.
 * Returns null when no candidate can identify the element at all: the caller
 * must then refuse to record the action instead of guessing.
 */
export function chooseSelector(info: ElementInfo): Selector | null {
  const candidates = buildCandidates(info);
  const unique = candidates.filter((c) => isUnique(info, c.strategy));
  const chosen = unique[0];
  if (!chosen) return null;

  const fallbackCandidate = buildFallback(info);
  const fallback =
    fallbackCandidate && fallbackCandidate !== chosen.value ? fallbackCandidate : null;

  return SelectorSchema.parse({
    strategy: chosen.strategy,
    value: chosen.value,
    role: chosen.role,
    name: chosen.name,
    fallback,
    pageId: info.pageId ?? "main",
    frame: info.frame ?? null
  });
}

/** Human readable description of a selector, safe to show in logs and UI. */
export function describeSelector(sel: Selector): string {
  if (sel.strategy === "role") {
    return `role=${sel.role}${sel.name ? `[name="${sel.name}"]` : ""}`;
  }
  return `${sel.strategy}=${sel.value}`;
}
