import { describe, it, expect } from "vitest";
import { settleAfterLastStep, type SettleTarget } from "./settle";

interface Fake {
  page: SettleTarget;
  calls: Array<{ state: string; timeout?: number }>;
  samples: number;
}

/**
 * A page whose fingerprint is read from a script: one entry per sample, the last
 * one repeating forever. `null` stands for a page that cannot be read.
 */
function pageShowing(
  script: Array<string | null>,
  behaviour: Partial<Record<"load" | "networkidle", () => Promise<void>>> = {}
): Fake {
  const fake: Fake = {
    calls: [],
    samples: 0,
    page: {
      async waitForLoadState(state, options) {
        fake.calls.push({ state, timeout: options?.timeout });
        const handler = behaviour[state];
        if (handler) await handler();
      },
      async fingerprint() {
        const value = script[Math.min(fake.samples, script.length - 1)];
        fake.samples += 1;
        return value;
      }
    }
  };
  return fake;
}

const opts = { timeoutMs: 2000, quietMs: 60, sampleMs: 10 };

describe("settleAfterLastStep", () => {
  it("waits for the page to load and then for the network to go quiet", async () => {
    const fake = pageShowing(["a"]);
    await settleAfterLastStep(fake.page, opts);
    expect(fake.calls.map((c) => c.state)).toEqual(["load", "networkidle"]);
    expect(fake.calls[0].timeout).toBe(2000);
  });

  it("returns once nothing has changed for the quiet stretch", async () => {
    const fake = pageShowing(["a"]);
    const started = Date.now();
    await settleAfterLastStep(fake.page, opts);
    expect(Date.now() - started).toBeGreaterThanOrEqual(60);
    expect(fake.samples).toBeGreaterThan(1);
  });

  it("keeps waiting for a page that routes after a pause", async () => {
    // The shape of the defect: the network falls quiet on a page that is about
    // to route somewhere else, and it holds still for a moment first — shorter
    // than the quiet stretch, which is what makes it a pause and not an end.
    const script = ["busy", "busy", "busy", "landed"];
    const fake = pageShowing(script);
    await settleAfterLastStep(fake.page, opts);
    // It cannot have stopped during the pause: it must have gone on past the
    // change and then waited for the new page to hold still in its turn.
    expect(fake.samples).toBeGreaterThan(script.length);
  });

  it("gives up at its deadline on a page that never holds still", async () => {
    let n = 0;
    const fake: Fake = {
      calls: [],
      samples: 0,
      page: {
        async waitForLoadState() {},
        async fingerprint() {
          n += 1;
          return `always different ${n}`;
        }
      }
    };
    const started = Date.now();
    await settleAfterLastStep(fake.page, { timeoutMs: 120, quietMs: 60, sampleMs: 10 });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(1000);
  });

  it("swallows a page that never goes quiet", async () => {
    const fake = pageShowing(["a"], {
      networkidle: () => Promise.reject(new Error("Timeout 5000ms exceeded"))
    });
    await expect(settleAfterLastStep(fake.page, opts)).resolves.toBeUndefined();
  });

  it("stops when the page can no longer be read", async () => {
    // A closed page answers nothing; waiting for it to hold still is pointless.
    const fake = pageShowing([null]);
    await settleAfterLastStep(fake.page, opts);
    expect(fake.samples).toBe(1);
  });
});
