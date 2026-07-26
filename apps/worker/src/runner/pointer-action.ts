import type { Locator, Page } from "playwright";

/**
 * Delivering a pointer action to an element a real page has covered.
 *
 * This is shared by the step runner and by the recorder's own interaction
 * endpoint on purpose: they drive the same kinds of page, so a control the runner
 * can operate must also be operable while recording, and the other way round.
 * Keeping two copies is what made the recorder fail on a covered radio that ran
 * perfectly at execution time.
 */

/**
 * True when an action failed only because another element sits on top of the
 * target. The usual cause is a styled label covering its own hidden checkbox or
 * radio, which is a legitimate page design rather than a broken selector.
 */
export function isPointerIntercepted(error: unknown): boolean {
  return ((error as Error)?.message ?? "").includes("intercepts pointer events");
}

/**
 * True when the element was clicked but its state did not follow. Typical of an
 * input whose state is owned by the page's own code: the browser's default toggle
 * is suppressed, so only the page's handler can change the selection.
 */
export function isStateUnchanged(error: unknown): boolean {
  return ((error as Error)?.message ?? "").includes("did not change its state");
}

/**
 * Finds the label that controls an input, which is what a person actually clicks
 * when the input itself is hidden underneath it.
 */
export async function associatedLabel(page: Page, locator: Locator): Promise<Locator | null> {
  const id = await locator.getAttribute("id").catch(() => null);
  if (id) {
    const byFor = page.locator(`label[for="${id.replace(/["\\]/g, "\\$&")}"]`);
    if ((await byFor.count()) === 1) return byFor;
  }
  const wrapping = locator.locator("xpath=ancestor::label[1]");
  if ((await wrapping.count()) === 1) return wrapping;
  return null;
}

/**
 * Performs a pointer action on an element that may be covered by its own label.
 *
 * Order matters, and it was learned the hard way on a real storefront. Clicking
 * the label is tried first, because that is what a person does and it is the only
 * thing that works when the page owns the input's state: forcing a click through
 * to the hidden input there leaves the selection unchanged and Playwright reports
 * "did not change its state". Forcing is kept as a last resort for elements that
 * are covered but have no label.
 *
 * This is not a retry: the element was found and is the right one, only the way
 * the action is delivered changes. A genuinely missing or ambiguous element still
 * fails immediately.
 */
export async function deliverPointerAction(options: {
  page: Page;
  locator: Locator;
  timeoutMs: number;
  action: (options: { timeout: number; force?: boolean }) => Promise<void>;
  onFallback?: (message: string) => Promise<void> | void;
}): Promise<void> {
  const { page, locator, timeoutMs, action, onFallback } = options;
  try {
    await action({ timeout: timeoutMs });
    return;
  } catch (err) {
    if (!isPointerIntercepted(err) && !isStateUnchanged(err)) throw err;

    const label = await associatedLabel(page, locator);
    if (label) {
      await onFallback?.("the input is covered by its own label; clicking the label instead");
      await label.click({ timeout: timeoutMs });
      return;
    }

    await onFallback?.("the element is covered and has no label; delivering the action to it directly");
    await action({ timeout: timeoutMs, force: true });
  }
}
