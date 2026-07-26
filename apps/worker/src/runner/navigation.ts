import type { Page } from "playwright";

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
