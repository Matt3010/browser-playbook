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
 * True when a pointer aimed at the element's own centre would not reach it:
 * it has no box, it is invisible, or something else is on top.
 *
 * Asked before acting rather than inferred from a timeout. Waiting for
 * Playwright's own retry loop to give up costs the whole step timeout — fifteen
 * seconds per covered control, every single run — and every hidden radio on a
 * storefront is covered by construction.
 */
async function isPointerBlocked(locator: Locator): Promise<boolean> {
  await locator.scrollIntoViewIfNeeded().catch(() => undefined);
  return locator
    .evaluate((el) => {
      const rect = (el as HTMLElement).getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return true;
      const style = window.getComputedStyle(el as HTMLElement);
      if (style.visibility === "hidden" || style.opacity === "0") return true;
      if (style.pointerEvents === "none") return true;
      const at = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return at !== el && !(el as HTMLElement).contains(at);
    })
    .catch(() => false);
}

/**
 * Performs a pointer action on an element a real page may have covered.
 *
 * The shape of this comes from two failures on a real storefront. Forcing the
 * action is useless when the page's own code owns the input's state: the click
 * lands on the hidden input, the selection does not move and Playwright reports
 * "did not change its state". And an input that cannot be reached at all must not
 * cost a full timeout to discover, so coverage is checked up front.
 *
 * The order is therefore: skip if the state is already right, click the
 * controlling label when the input itself is unreachable, and only fall back to
 * the raw action — finally forcing it — when that did not work. Every branch that
 * goes through the label re-reads the state afterwards, so a click that changed
 * nothing is never mistaken for success.
 *
 * `desiredState` must be set for check/uncheck and left out for a plain click.
 * Without it the label route would not be idempotent: clicking the label of an
 * already ticked box unticks it.
 */
export async function deliverPointerAction(options: {
  page: Page;
  locator: Locator;
  timeoutMs: number;
  action: (options: { timeout: number; force?: boolean }) => Promise<void>;
  /** true for check, false for uncheck, omitted for actions with no state. */
  desiredState?: boolean;
  onFallback?: (message: string) => Promise<void> | void;
}): Promise<void> {
  const { page, locator, timeoutMs, action, desiredState, onFallback } = options;

  const stateIs = async (expected: boolean): Promise<boolean> =>
    locator
      .isChecked({ timeout: timeoutMs })
      .then((checked) => checked === expected)
      .catch(() => false);

  // Playwright's check() is a no-op on a box already in the requested state, and so
  // is this: the state is read before anything is clicked.
  if (desiredState !== undefined && (await stateIs(desiredState))) return;

  if (await isPointerBlocked(locator)) {
    const label = await associatedLabel(page, locator);
    if (label) {
      await onFallback?.("the input is covered by its own label; clicking the label instead");
      await label.click({ timeout: timeoutMs });
      if (desiredState === undefined || (await stateIs(desiredState))) return;
      await onFallback?.("the label click did not move the state; acting on the input itself");
    }
  }

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
