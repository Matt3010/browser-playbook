import { describe, it, expect } from "vitest";
import { settleAfterLastStep, type SettleTarget } from "./settle";

interface Fake {
  page: SettleTarget;
  calls: Array<{ state: string; timeout?: number }>;
  quietAsked: number[];
}

/**
 * A page that answers the two load states immediately and reports it has held
 * still after `quietAfterMs` — or never, when that is null.
 */
function pageThat(options: {
  quietAfterMs: number | null;
  loadState?: Partial<Record<"load" | "networkidle", () => Promise<void>>>;
  quietFails?: boolean;
}): Fake {
  const fake: Fake = {
    calls: [],
    quietAsked: [],
    page: {
      async waitForLoadState(state, opts) {
        fake.calls.push({ state, timeout: opts?.timeout });
        const handler = options.loadState?.[state];
        if (handler) await handler();
      },
      waitUntilQuiet(quietMs) {
        fake.quietAsked.push(quietMs);
        if (options.quietFails) return Promise.reject(new Error("page closed"));
        if (options.quietAfterMs === null) return new Promise<void>(() => undefined);
        return new Promise<void>((resolve) => setTimeout(resolve, options.quietAfterMs!));
      }
    }
  };
  return fake;
}

describe("settleAfterLastStep", () => {
  it("waits for load, then for the network, then for the page to hold still", async () => {
    const fake = pageThat({ quietAfterMs: 10 });
    await settleAfterLastStep(fake.page, { timeoutMs: 2000, quietMs: 40 });
    expect(fake.calls.map((c) => c.state)).toEqual(["load", "networkidle"]);
    expect(fake.calls[0].timeout).toBe(2000);
    expect(fake.quietAsked).toEqual([40]);
  });

  it("gives up at its deadline on a page that never holds still", async () => {
    // A poller, a chat widget, a ticking clock: the steps have all succeeded, so
    // this must end the wait rather than the run.
    const fake = pageThat({ quietAfterMs: null });
    const started = Date.now();
    await settleAfterLastStep(fake.page, { timeoutMs: 120, quietMs: 40 });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(1500);
  });

  it("swallows a page that cannot report at all", async () => {
    const fake = pageThat({ quietAfterMs: null, quietFails: true });
    await expect(
      settleAfterLastStep(fake.page, { timeoutMs: 2000, quietMs: 40 })
    ).resolves.toBeUndefined();
  });

  it("swallows a page whose network never goes quiet", async () => {
    const fake = pageThat({
      quietAfterMs: 10,
      loadState: { networkidle: () => Promise.reject(new Error("Timeout 5000ms exceeded")) }
    });
    await expect(
      settleAfterLastStep(fake.page, { timeoutMs: 2000, quietMs: 40 })
    ).resolves.toBeUndefined();
  });

  it("does not ask the page to hold still once the budget is spent", async () => {
    const fake = pageThat({
      quietAfterMs: 10,
      loadState: { load: () => new Promise((resolve) => setTimeout(resolve, 60)) }
    });
    await settleAfterLastStep(fake.page, { timeoutMs: 50, quietMs: 40 });
    expect(fake.quietAsked).toEqual([]);
  });
});
