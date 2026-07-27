/**
 * Waiting for the effect of the last step, before the browser is taken away.
 *
 * Every step but the last is followed by one that waits for its own element,
 * which absorbs whatever the previous step set in motion. The last step has
 * nothing after it: the runner read the URL and closed the browser within half a
 * second of the click, so a request that click had just sent could be cancelled
 * by the teardown — including the closing action, the one step whose entire
 * purpose is to act on the site. Playwright waits for a *navigation* an action
 * starts, so a classic form submit was covered; a page that posts with `fetch`
 * and then routes itself was not, which is what modern applications do.
 */

/** The part of Playwright's Page this needs, so a test can stand in for it. */
export interface SettleablePage {
  waitForLoadState(state: "load" | "networkidle", options?: { timeout?: number }): Promise<void>;
}

/** How long the runner is willing to wait for the last step to land. */
export const SETTLE_TIMEOUT_MS = 15_000;

/**
 * Never throws and never fails the execution: every step has already succeeded,
 * and a page that simply never goes quiet — a poller, a chat widget, an open
 * event stream — must not turn a good run into a failed one. It buys the effect
 * a chance to land, nothing more.
 */
export async function settleAfterLastStep(
  page: SettleablePage,
  timeoutMs: number = SETTLE_TIMEOUT_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  await page.waitForLoadState("load", { timeout: timeoutMs }).catch(() => undefined);
  const remaining = deadline - Date.now();
  if (remaining <= 0) return;
  await page.waitForLoadState("networkidle", { timeout: remaining }).catch(() => undefined);
}
