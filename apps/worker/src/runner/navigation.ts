import type { Page } from "playwright";
import { assertSafeTargetUrl, type UrlSafetyOptions } from "@app/shared";

/** URLs that carry no network target and are therefore always acceptable. */
const NEUTRAL_URLS = new Set(["", "about:blank", "about:srcdoc", "chrome://newtab/"]);

/**
 * How long any navigation in this product is given to bring back a document.
 *
 * One number, in one place, because it used to be two. Opening a session's start
 * URL waited 45 s and the recorded `goto` to the same address waited the default
 * step timeout of 10 s — the same function, the same page, and the tighter budget
 * on the side that matters. A real product page on a real connection takes longer
 * than ten seconds, so a site could be recorded and could not be replayed, which
 * this project treats as a contradiction rather than a limitation.
 */
export const NAVIGATION_TIMEOUT_MS = 45_000;

/**
 * What a `goto` step is actually given.
 *
 * `timeoutMs` on a step answers "how long to look for an element", and the editor
 * has never offered a way to change it, so the 10 000 sitting on every saved step
 * is a default rather than anybody's decision — overriding it takes nothing away.
 * A step that asks for *more* is another matter and is left alone: someone who
 * says a site needs two minutes knows something we do not.
 */
export function navigationBudgetMs(stepTimeoutMs: number): number {
  return Math.max(stepTimeoutMs, NAVIGATION_TIMEOUT_MS);
}

/**
 * Re-checks where a navigation actually ended up.
 *
 * Validating only the requested URL is not enough: a page is free to redirect the
 * browser anywhere, including a private address or another container on the
 * internal network. Since the resulting page is visible over noVNC and readable
 * by assertion steps, an unchecked redirect would be a way around the URL guard.
 */
export function assertSafeLandedUrl(
  landedUrl: string,
  options: UrlSafetyOptions,
  requestedUrl?: string
): void {
  if (NEUTRAL_URLS.has(landedUrl)) return;
  try {
    assertSafeTargetUrl(landedUrl, options);
  } catch (err) {
    const from = requestedUrl && requestedUrl !== landedUrl ? ` from ${requestedUrl}` : "";
    throw new Error(
      `Navigation${from} ended on a blocked address (${landedUrl}): ${(err as Error).message}`
    );
  }
}

/**
 * A navigation that the page itself replaced. Real sites do this constantly:
 * locale redirects, consent walls, A/B routers. Playwright reports it as an
 * error even though the browser is simply somewhere else now.
 */
export function isSupersededNavigation(error: unknown): boolean {
  const message = (error as Error)?.message ?? "";
  return (
    message.includes("interrupted by another navigation") ||
    message.includes("Navigation to") && message.includes("is interrupted")
  );
}

/**
 * Navigates to a URL, tolerating the site redirecting itself somewhere else
 * during the navigation. The step is not treated as failed: the following steps
 * decide whether the page that was reached is usable, which is exactly how a
 * human would judge it.
 *
 * Any other navigation error (DNS, timeout, connection refused) still fails.
 */
export async function gotoTolerantOfRedirects(
  page: Page,
  url: string,
  timeoutMs: number,
  onWarning?: (message: string) => void | Promise<void>
): Promise<void> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  } catch (err) {
    if (!isSupersededNavigation(err)) throw err;

    // Let the redirect chain settle, then carry on from wherever it landed.
    await page
      .waitForLoadState("domcontentloaded", { timeout: timeoutMs })
      .catch(() => undefined);

    let landedOn = "";
    try {
      landedOn = page.url();
    } catch {
      /* the page may be mid-navigation */
    }
    await onWarning?.(
      `the site redirected during navigation to ${url}` +
        (landedOn ? `; continuing on ${landedOn}` : "")
    );
  }
}
