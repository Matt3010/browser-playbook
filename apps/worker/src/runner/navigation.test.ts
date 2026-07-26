import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import { gotoTolerantOfRedirects, isSupersededNavigation } from "./navigation";

function fakePage(overrides: Partial<Page> = {}): Page {
  return {
    goto: vi.fn().mockResolvedValue(null),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockReturnValue("https://example.com/landed"),
    ...overrides
  } as unknown as Page;
}

describe("isSupersededNavigation", () => {
  it("recognises a navigation replaced by the page itself", () => {
    expect(
      isSupersededNavigation(
        new Error(
          'page.goto: Navigation to "https://www.apple.com/it/shop/buy-mac/macbook-air" is ' +
            'interrupted by another navigation to "https://www.apple.com/it/"'
        )
      )
    ).toBe(true);
  });

  it("does not swallow real navigation failures", () => {
    for (const message of [
      "page.goto: net::ERR_NAME_NOT_RESOLVED at https://nope.invalid/",
      "page.goto: Timeout 10000ms exceeded",
      "page.goto: net::ERR_CONNECTION_REFUSED"
    ]) {
      expect(isSupersededNavigation(new Error(message)), message).toBe(false);
    }
  });

  it("tolerates a non-error value", () => {
    expect(isSupersededNavigation(undefined)).toBe(false);
    expect(isSupersededNavigation("boom")).toBe(false);
  });
});

describe("gotoTolerantOfRedirects", () => {
  it("navigates normally when nothing interferes", async () => {
    const page = fakePage();
    const onWarning = vi.fn();
    await gotoTolerantOfRedirects(page, "https://example.com", 5000, onWarning);

    expect(page.goto).toHaveBeenCalledWith("https://example.com", {
      waitUntil: "domcontentloaded",
      timeout: 5000
    });
    expect(onWarning).not.toHaveBeenCalled();
  });

  it("continues, and warns, when the site redirects during the navigation", async () => {
    const page = fakePage({
      goto: vi
        .fn()
        .mockRejectedValue(
          new Error('Navigation to "https://a.test/x" is interrupted by another navigation to "https://a.test/"')
        )
    });
    const warnings: string[] = [];

    await gotoTolerantOfRedirects(page, "https://a.test/x", 5000, (m) => {
      warnings.push(m);
    });

    // It waited for the redirect chain to settle instead of failing the step.
    expect(page.waitForLoadState).toHaveBeenCalled();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("redirected during navigation");
    expect(warnings[0]).toContain("https://example.com/landed");
  });

  it("still fails on a genuine navigation error", async () => {
    const page = fakePage({
      goto: vi.fn().mockRejectedValue(new Error("page.goto: net::ERR_NAME_NOT_RESOLVED"))
    });
    await expect(
      gotoTolerantOfRedirects(page, "https://nope.invalid", 5000)
    ).rejects.toThrow(/ERR_NAME_NOT_RESOLVED/);
    expect(page.waitForLoadState).not.toHaveBeenCalled();
  });

  it("does not fail if the settle wait itself times out", async () => {
    const page = fakePage({
      goto: vi.fn().mockRejectedValue(new Error("is interrupted by another navigation")),
      waitForLoadState: vi.fn().mockRejectedValue(new Error("Timeout"))
    });
    await expect(gotoTolerantOfRedirects(page, "https://a.test", 5000)).resolves.toBeUndefined();
  });
});
