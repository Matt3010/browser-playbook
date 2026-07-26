import type { FrameLocator, Locator, Page } from "playwright";
import { describeSelector, type Selector } from "@app/workflow-schema";

export class SelectorNotFoundError extends Error {
  constructor(selector: Selector) {
    super(`No element matches selector ${describeSelector(selector)}`);
  }
}

export class SelectorAmbiguousError extends Error {
  constructor(selector: Selector, count: number) {
    super(
      `Selector ${describeSelector(selector)} matches ${count} elements; ` +
        `the workflow stops instead of guessing which one to use`
    );
  }
}

/** Anything a locator can be built from: the page itself or a same-origin frame. */
type LocatorRoot = Page | FrameLocator;

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

function build(root: LocatorRoot, selector: Selector): Locator {
  switch (selector.strategy) {
    case "role":
      return root.getByRole(selector.role as never, { name: selector.name, exact: true });
    case "label":
      return root.getByLabel(selector.value as string, { exact: true });
    case "placeholder":
      return root.getByPlaceholder(selector.value as string, { exact: true });
    case "text":
      return root.getByText(selector.value as string, { exact: true });
    case "testid":
      return root.getByTestId(selector.value as string);
    case "name":
      return root.locator(`[name="${cssEscape(selector.value as string)}"]`);
    case "id":
      return root.locator(`#${cssEscape(selector.value as string)}`);
    case "css":
      return root.locator(selector.value as string);
    case "xpath":
      return root.locator(`xpath=${selector.value as string}`);
    default:
      throw new Error(`Unsupported selector strategy: ${selector.strategy}`);
  }
}

/** A selector recorded inside a same-origin iframe resolves through that frame. */
function rootFor(page: Page, selector: Selector): LocatorRoot {
  return selector.frame ? page.frameLocator(selector.frame) : page;
}

function rawLocator(root: LocatorRoot, raw: string): Locator {
  return raw.startsWith("/") ? root.locator(`xpath=${raw}`) : root.locator(raw);
}

export interface ResolveResult {
  locator: Locator;
  usedFallback: boolean;
}

/**
 * Resolves a selector to exactly one element.
 *
 * The primary selector is tried first; the recorded raw fallback is used only
 * when the primary matches nothing. An ambiguous match is always an error: the
 * MVP never picks the first of several candidates.
 */
export async function resolveUnique(
  page: Page,
  selector: Selector,
  timeoutMs: number
): Promise<ResolveResult> {
  const root = rootFor(page, selector);
  const primary = build(root, selector);

  const primaryCount = await countWithin(primary, timeoutMs);
  if (primaryCount === 1) return { locator: primary, usedFallback: false };
  if (primaryCount > 1) throw new SelectorAmbiguousError(selector, primaryCount);

  if (selector.fallback) {
    const fallback = rawLocator(root, selector.fallback);
    const fallbackCount = await countWithin(fallback, Math.min(timeoutMs, 3000));
    if (fallbackCount === 1) return { locator: fallback, usedFallback: true };
    if (fallbackCount > 1) throw new SelectorAmbiguousError(selector, fallbackCount);
  }

  throw new SelectorNotFoundError(selector);
}

/**
 * Waits until the locator matches at least one element, then reports how many it
 * matches. Returns 0 when nothing appears within the timeout.
 */
async function countWithin(locator: Locator, timeoutMs: number): Promise<number> {
  try {
    await locator.first().waitFor({ state: "attached", timeout: timeoutMs });
  } catch {
    return 0;
  }
  return locator.count();
}
