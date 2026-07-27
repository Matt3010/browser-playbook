/**
 * Waiting for the effect of the last step, before the browser is taken away.
 *
 * Every step but the last is followed by one that waits for its own element,
 * which absorbs whatever the previous step set in motion. The last step has
 * nothing after it: the runner read the URL and closed the browser within half a
 * second of the click, so a request that click had just sent could be cancelled
 * by the teardown — including the closing action, the one step whose entire
 * purpose is to act on the site.
 *
 * Waiting for the network to go quiet is not enough on its own. An application
 * posts, gets its answer, and routes a moment later; in between, the network is
 * idle and the page is still on its way — which is exactly the state the first
 * version of this photographed, a button reading "Creating repository…".
 *
 * So the run is over when the page has *stopped changing*, which the page itself
 * reports through a `MutationObserver` (see `quiet.ts`). Two waits remain that no
 * event can replace, and both are decisions rather than measurements:
 * how much silence counts as the end, and how long we are willing to wait at all.
 */

/** What this needs from a page, so a test can stand in for one. */
export interface SettleTarget {
  waitForLoadState(state: "load" | "networkidle", options?: { timeout?: number }): Promise<void>;
  /** Resolves when the page reports it has held still for `quietMs`. */
  waitUntilQuiet(quietMs: number): Promise<void>;
}

/** The whole wait is bounded: a page that never settles must not hold the run. */
export const SETTLE_TIMEOUT_MS = 20_000;
/** How long nothing may change before the page counts as settled. */
export const SETTLE_QUIET_MS = 2_000;

export interface SettleOptions {
  timeoutMs?: number;
  quietMs?: number;
}

/**
 * Never throws and never fails the execution: every step has already succeeded,
 * and a page that simply never holds still — a poller, a chat widget, a ticking
 * clock — must not turn a good run into a failed one. It buys the effect a
 * chance to land, nothing more.
 */
export async function settleAfterLastStep(
  page: SettleTarget,
  options: SettleOptions = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? SETTLE_TIMEOUT_MS;
  const quietMs = options.quietMs ?? SETTLE_QUIET_MS;
  const deadline = Date.now() + timeoutMs;
  const remaining = () => deadline - Date.now();

  await page.waitForLoadState("load", { timeout: timeoutMs }).catch(() => undefined);
  if (remaining() > 0) {
    await page.waitForLoadState("networkidle", { timeout: remaining() }).catch(() => undefined);
  }
  if (remaining() <= 0) return;

  await Promise.race([
    page.waitUntilQuiet(quietMs).catch(() => undefined),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, remaining());
      // Nothing else is waiting on this timer: let the process exit without it.
      timer.unref?.();
    })
  ]);
}
