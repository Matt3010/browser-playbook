import { describe, it, expect } from "vitest";
import { settleAfterLastStep, type SettleablePage } from "./settle";

function pageThat(
  behaviour: Partial<Record<"load" | "networkidle", () => Promise<void>>>
): { page: SettleablePage; calls: Array<{ state: string; timeout?: number }> } {
  const calls: Array<{ state: string; timeout?: number }> = [];
  const page: SettleablePage = {
    async waitForLoadState(state, options) {
      calls.push({ state, timeout: options?.timeout });
      const handler = behaviour[state];
      if (handler) await handler();
    }
  };
  return { page, calls };
}

describe("settleAfterLastStep", () => {
  it("waits for the page to load and then to go quiet", async () => {
    const { page, calls } = pageThat({});
    await settleAfterLastStep(page, 5000);
    expect(calls.map((c) => c.state)).toEqual(["load", "networkidle"]);
    expect(calls[0].timeout).toBe(5000);
    expect(calls[1].timeout).toBeLessThanOrEqual(5000);
  });

  it("swallows a page that never goes quiet", async () => {
    // A poller or a chat widget keeps the network busy forever. The steps have
    // all succeeded already, so this must never fail the execution.
    const { page } = pageThat({
      networkidle: () => Promise.reject(new Error("Timeout 5000ms exceeded"))
    });
    await expect(settleAfterLastStep(page, 5000)).resolves.toBeUndefined();
  });

  it("swallows a page that is already gone", async () => {
    const { page, calls } = pageThat({
      load: () => Promise.reject(new Error("Target page, context or browser has been closed"))
    });
    await expect(settleAfterLastStep(page, 5000)).resolves.toBeUndefined();
    // The second wait is still attempted: one closed page is not proof the other
    // wait would fail too, and it is bounded and harmless.
    expect(calls).toHaveLength(2);
  });

  it("does not wait past its budget", async () => {
    const { page, calls } = pageThat({
      load: () => new Promise((resolve) => setTimeout(resolve, 60))
    });
    await settleAfterLastStep(page, 50);
    // The load wait consumed the whole budget, so no quiet wait is attempted.
    expect(calls.map((c) => c.state)).toEqual(["load"]);
  });
});
