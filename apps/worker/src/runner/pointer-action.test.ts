import { describe, expect, it, vi } from "vitest";
import type { Locator, Page } from "playwright";
import { deliverPointerAction, isPointerIntercepted, isStateUnchanged } from "./pointer-action";

const INTERCEPTED = new Error(
  "locator.check: Timeout 15000ms exceeded.\nCall log:\n" +
    '  - <span>Da € 1.749,00</span> from <label for="_r_e_">…</label> subtree intercepts pointer events'
);
const STATE_UNCHANGED = new Error("locator.check: Clicking the checkbox did not change its state");

interface FakeLocatorOptions {
  /** What a pointer aimed at the element's own centre would reach. */
  pointerBlocked?: boolean;
  /** Successive answers of isChecked(); the last one repeats. */
  checkedStates?: boolean[];
  labelCount?: number;
}

function fakeLocator(options: FakeLocatorOptions = {}) {
  const states = options.checkedStates ?? [false];
  let call = 0;
  const label = {
    count: vi.fn().mockResolvedValue(options.labelCount ?? 0),
    click: vi.fn().mockResolvedValue(undefined)
  };
  const locator = {
    getAttribute: vi.fn().mockResolvedValue("_r_e_"),
    scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(options.pointerBlocked ?? false),
    isChecked: vi.fn().mockImplementation(() => {
      const value = states[Math.min(call, states.length - 1)]!;
      call += 1;
      return Promise.resolve(value);
    }),
    locator: vi.fn().mockReturnValue(label)
  };
  const page = { locator: vi.fn().mockReturnValue(label) } as unknown as Page;
  return { locator: locator as unknown as Locator, page, label };
}

describe("recognising why an action failed", () => {
  it("tells a covered element from a state the page refused to move", () => {
    expect(isPointerIntercepted(INTERCEPTED)).toBe(true);
    expect(isStateUnchanged(INTERCEPTED)).toBe(false);
    expect(isStateUnchanged(STATE_UNCHANGED)).toBe(true);
    expect(isPointerIntercepted(new Error("Timeout 15000ms exceeded"))).toBe(false);
  });
});

describe("deliverPointerAction", () => {
  it("does nothing when the box is already in the requested state", async () => {
    // check() is idempotent, and going through the label is not: clicking the label
    // of an already ticked box unticks it. Reading the state first is what makes the
    // label route safe.
    const { locator, page, label } = fakeLocator({ checkedStates: [true] });
    const action = vi.fn().mockResolvedValue(undefined);

    await deliverPointerAction({ page, locator, timeoutMs: 15_000, action, desiredState: true });

    expect(action).not.toHaveBeenCalled();
    expect(label.click).not.toHaveBeenCalled();
  });

  it("clicks the label straight away when the input cannot be reached", async () => {
    // The old code learned this only from a 15 second timeout. Every covered radio
    // on a storefront paid that once, for nothing.
    const { locator, page, label } = fakeLocator({
      pointerBlocked: true,
      labelCount: 1,
      checkedStates: [false, true]
    });
    const action = vi.fn().mockResolvedValue(undefined);
    const messages: string[] = [];

    await deliverPointerAction({
      page,
      locator,
      timeoutMs: 15_000,
      action,
      desiredState: true,
      onFallback: (m) => void messages.push(m)
    });

    expect(label.click).toHaveBeenCalledTimes(1);
    expect(action).not.toHaveBeenCalled();
    expect(messages.join(" ")).toMatch(/covered by its own label/);
  });

  it("does not trust the label click: falls through when the state did not move", async () => {
    const { locator, page, label } = fakeLocator({
      pointerBlocked: true,
      labelCount: 1,
      checkedStates: [false, false]
    });
    const action = vi.fn().mockResolvedValue(undefined);

    await deliverPointerAction({ page, locator, timeoutMs: 15_000, action, desiredState: true });

    expect(label.click).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("leaves a reachable element alone", async () => {
    // A plain checkbox with a label beside it must keep being clicked directly: a
    // label may wrap other interactive content, so the shortcut is only for inputs
    // a pointer cannot reach.
    const { locator, page, label } = fakeLocator({ pointerBlocked: false, labelCount: 1 });
    const action = vi.fn().mockResolvedValue(undefined);

    await deliverPointerAction({ page, locator, timeoutMs: 15_000, action, desiredState: true });

    expect(action).toHaveBeenCalledTimes(1);
    expect(label.click).not.toHaveBeenCalled();
  });

  it("still recovers when the interception only shows up while acting", async () => {
    const { locator, page, label } = fakeLocator({ pointerBlocked: false, labelCount: 1 });
    const action = vi.fn().mockRejectedValueOnce(INTERCEPTED).mockResolvedValue(undefined);

    await deliverPointerAction({ page, locator, timeoutMs: 15_000, action });

    expect(label.click).toHaveBeenCalledTimes(1);
  });

  it("forces the action only for a covered element with no label", async () => {
    const { locator, page } = fakeLocator({ pointerBlocked: true, labelCount: 0 });
    const action = vi.fn().mockRejectedValueOnce(INTERCEPTED).mockResolvedValue(undefined);

    await deliverPointerAction({ page, locator, timeoutMs: 15_000, action });

    expect(action).toHaveBeenCalledTimes(2);
    expect(action.mock.calls[1]![0]).toMatchObject({ force: true });
  });

  it("propagates a failure that is not about coverage", async () => {
    const { locator, page } = fakeLocator();
    const action = vi.fn().mockRejectedValue(new Error("strict mode violation: 2 elements"));

    await expect(
      deliverPointerAction({ page, locator, timeoutMs: 15_000, action })
    ).rejects.toThrow(/strict mode violation/);
  });
});
