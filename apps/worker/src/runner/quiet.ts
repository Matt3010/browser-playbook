import type { Page } from "playwright";

/**
 * "The page has stopped changing", asked of the browser rather than of a clock.
 *
 * A `MutationObserver` inside the document reports every change there is —
 * nodes, text, attributes — so nothing has to be sampled and compared from the
 * outside. Each change pushes a timer back; when the timer finally fires, the
 * page calls Node through an exposed function. The only wait left is the one
 * that cannot be observed at all: no browser emits "nothing more will happen",
 * so how much silence counts as the end stays a decision, made once, in
 * `settle.ts`.
 *
 * A navigation replaces the document and takes the observer with it, so the
 * watcher re-installs on every main-frame navigation: the quiet stretch is then
 * measured on the page the run actually ended on.
 */
export interface QuietWatcher {
  /** Resolves when the page has held still for `quietMs`, or when it is gone. */
  waitUntilQuiet(quietMs: number): Promise<void>;
  /** Detaches the navigation listener. The exposed function dies with the page. */
  dispose(): void;
}

/** Installed in every document; self-contained, it is serialised into the page. */
function observeQuiet(arg: { callback: string; quietMs: number }): void {
  const w = window as unknown as Record<string, unknown>;
  // One observer per document, however many times the runner re-installs it.
  if (w.__settleObserving === arg.callback) return;
  w.__settleObserving = arg.callback;

  let timer: ReturnType<typeof setTimeout> | null = null;
  const announce = () => {
    const notify = w[arg.callback];
    if (typeof notify === "function") (notify as () => void)();
  };
  const restart = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(announce, arg.quietMs);
  };

  new MutationObserver(restart).observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true
  });
  restart();
}

export async function watchQuiet(page: Page): Promise<QuietWatcher> {
  // A name of its own: an exposed function cannot be registered twice, and it
  // outlives the wait that asked for it.
  const callback = `__settleQuiet_${Math.random().toString(36).slice(2, 10)}`;
  let announce: (() => void) | null = null;

  await page.exposeFunction(callback, () => announce?.()).catch(() => undefined);

  let quietMs = 0;
  const install = () =>
    page.evaluate(observeQuiet, { callback, quietMs }).catch(() => undefined);

  const onNavigated = (frame: { parentFrame(): unknown }) => {
    if (frame.parentFrame() !== null) return;
    void install();
  };
  page.on("framenavigated", onNavigated);

  return {
    async waitUntilQuiet(ms: number): Promise<void> {
      quietMs = ms;
      await new Promise<void>((resolve) => {
        announce = resolve;
        // A page that is already gone can never announce anything.
        page.once("close", () => resolve());
        void install();
      });
      announce = null;
    },
    dispose(): void {
      page.off("framenavigated", onNavigated);
    }
  };
}
