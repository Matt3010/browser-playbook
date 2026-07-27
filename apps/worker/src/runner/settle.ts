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
 * So the run is over when the page has *stopped changing*: same address, same
 * document, same text, for a quiet stretch. That is what a person waits for.
 */

/** What this needs from a page, so a test can stand in for one. */
export interface SettleTarget {
  waitForLoadState(state: "load" | "networkidle", options?: { timeout?: number }): Promise<void>;
  /** A cheap description of what the page is showing right now, or null. */
  fingerprint(): Promise<string | null>;
}

/** The whole wait is bounded: a page that never settles must not hold the run. */
export const SETTLE_TIMEOUT_MS = 20_000;
/** How long nothing may change before the page counts as settled. */
export const SETTLE_QUIET_MS = 2_000;
/** How often the page is sampled while waiting for it to hold still. */
export const SETTLE_SAMPLE_MS = 250;

export interface SettleOptions {
  timeoutMs?: number;
  quietMs?: number;
  sampleMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const sampleMs = options.sampleMs ?? SETTLE_SAMPLE_MS;
  const deadline = Date.now() + timeoutMs;

  const remaining = () => deadline - Date.now();

  await page.waitForLoadState("load", { timeout: timeoutMs }).catch(() => undefined);
  if (remaining() > 0) {
    await page.waitForLoadState("networkidle", { timeout: remaining() }).catch(() => undefined);
  }

  let previous: string | null = null;
  let unchangedSince = Date.now();

  while (remaining() > 0) {
    const current = await page.fingerprint().catch(() => null);
    // A page that cannot be read is a page that cannot be waited for either.
    if (current === null) return;

    if (current === previous) {
      if (Date.now() - unchangedSince >= quietMs) return;
    } else {
      previous = current;
      unchangedSince = Date.now();
    }

    await sleep(Math.min(sampleMs, Math.max(remaining(), 0)));
  }
}
