import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { chromium, type BrowserContext, type Page } from "playwright";
import {
  actionsToSteps,
  RecordedActionSchema,
  type RecordedAction,
  type Step
} from "@app/workflow-schema";
import type { Logger } from "@app/shared";
import {
  spawnManaged,
  killManaged,
  waitForPort,
  waitForFile,
  type ManagedProcess
} from "./process-utils";
import type { SessionSlot } from "./allocator";
import { recorderBrowserScript } from "../recorder/browser-script";
import { buildHighlightCss, DEFAULT_RECORDER_COLORS } from "../recorder/highlight-css";
import { assertSafeLandedUrl, gotoTolerantOfRedirects } from "../runner/navigation";

const TOOLTIP_ID = "__recorder_tooltip__";

export type SessionState = "creating" | "ready" | "running" | "closed" | "error";

export interface SessionOptions {
  sessionId: string;
  userId: string;
  startUrl: string;
  timeoutMs: number;
  /**
   * When set, the session closes itself after this long without being touched by
   * a request. It reclaims the slot of a session whose page was closed or
   * abandoned. Sessions driven by a running execution leave it unset, because
   * nothing polls them from outside.
   */
  idleTimeoutMs?: number | null;
  slot: SessionSlot;
  screenWidth: number;
  screenHeight: number;
  logger: Logger;
  /** Used to refuse a navigation that lands on a blocked address after a redirect. */
  urlSafety: { allowPrivateTargets: boolean; allowedHosts: string[] };
  /** Called when the session closes itself (timeout or crash). */
  onClosed: (sessionId: string) => void;
}

interface TrackedPage {
  pageId: string;
  page: Page;
}

/** Milliseconds after an interaction during which a navigation is considered
 *  a consequence of that interaction, and therefore not recorded separately. */
const NAVIGATION_DEBOUNCE_MS = 1500;

export class BrowserSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly startUrl: string;
  readonly slot: SessionSlot;

  state: SessionState = "creating";
  error: string | null = null;
  recording = false;
  highlight = true;
  /** Armed to capture the next interaction without letting the page perform it. */
  armedFinal = false;
  readonly expiresAt: Date;

  private readonly options: SessionOptions;
  private readonly log: Logger;
  private readonly processes: ManagedProcess[] = [];
  private profileDir: string | null = null;
  private context: BrowserContext | null = null;
  private readonly pages: TrackedPage[] = [];
  private activePageId = "main";
  private nextTabIndex = 0;
  private readonly actions: RecordedAction[] = [];
  private lastActionAt = 0;
  private timeoutTimer: NodeJS.Timeout | null = null;
  private closing = false;
  private lastTouchedAt = Date.now();
  readonly idleTimeoutMs: number | null;

  constructor(options: SessionOptions) {
    this.options = options;
    this.sessionId = options.sessionId;
    this.userId = options.userId;
    this.startUrl = options.startUrl;
    this.slot = options.slot;
    this.log = options.logger.child({ sessionId: options.sessionId });
    this.expiresAt = new Date(Date.now() + options.timeoutMs);
    this.idleTimeoutMs = options.idleTimeoutMs ?? null;
  }

  /** Records that something is still driving this session. */
  touch(): void {
    this.lastTouchedAt = Date.now();
  }

  get idleMs(): number {
    return Date.now() - this.lastTouchedAt;
  }

  /** True when nobody has touched the session for longer than allowed. */
  isIdle(): boolean {
    return this.idleTimeoutMs !== null && this.idleMs > this.idleTimeoutMs;
  }

  // ---- lifecycle ---------------------------------------------------------

  async start(): Promise<void> {
    try {
      await this.startDisplay();
      await this.startVnc();
      await this.startBrowser();
      this.armTimeout();
      this.state = "ready";
      this.log.info(
        { display: this.slot.display, vncPort: this.slot.vncPort },
        "Browser session ready"
      );
    } catch (err) {
      this.state = "error";
      this.error = (err as Error).message;
      this.log.error({ err }, "Browser session failed to start");
      await this.close();
      throw err;
    }
  }

  private async startDisplay(): Promise<void> {
    const { display } = this.slot;
    const geometry = `${this.options.screenWidth}x${this.options.screenHeight}x24`;
    this.processes.push(
      spawnManaged("Xvfb", "Xvfb", [
        `:${display}`,
        "-screen",
        "0",
        geometry,
        "-nolisten",
        "tcp",
        "-dpi",
        "96"
      ])
    );
    await waitForFile(`/tmp/.X11-unix/X${display}`, 15000);
  }

  private async startVnc(): Promise<void> {
    const { display, rfbPort, vncPort } = this.slot;

    // x11vnc listens on loopback only: the RFB port is never reachable from
    // outside the container.
    this.processes.push(
      spawnManaged("x11vnc", "x11vnc", [
        "-display",
        `:${display}`,
        "-rfbport",
        String(rfbPort),
        "-localhost",
        "-nopw",
        "-forever",
        "-shared",
        "-noxdamage",
        "-quiet"
      ])
    );
    await waitForPort(rfbPort, 15000);

    // websockify exposes the WebSocket endpoint the API proxies to. It binds on
    // all interfaces of the internal Docker network only (never published).
    this.processes.push(
      spawnManaged("websockify", "websockify", [
        `0.0.0.0:${vncPort}`,
        `127.0.0.1:${rfbPort}`
      ])
    );
    await waitForPort(vncPort, 15000, "0.0.0.0");
  }

  private async startBrowser(): Promise<void> {
    this.profileDir = await mkdtemp(path.join(tmpdir(), `session-${this.sessionId}-`));

    this.context = await chromium.launchPersistentContext(this.profileDir, {
      headless: false,
      viewport: null,
      acceptDownloads: true,
      env: { ...process.env, DISPLAY: `:${this.slot.display}` },
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-infobars",
        "--disable-session-crashed-bubble",
        "--disable-features=TranslateUI,MediaRouter",
        `--window-size=${this.options.screenWidth},${this.options.screenHeight}`,
        "--window-position=0,0"
      ]
    });

    await this.context.exposeBinding("__recorderEmit", (_source, payload) => {
      this.handleEmittedAction(payload as Record<string, unknown>, _source.page);
    });
    await this.context.exposeBinding("__recorderConfig", () => ({
      recording: this.recording,
      highlight: this.highlight,
      armedFinal: this.armedFinal
    }));
    await this.context.addInitScript(recorderBrowserScript, {
      css: buildHighlightCss(DEFAULT_RECORDER_COLORS, TOOLTIP_ID),
      tooltipId: TOOLTIP_ID
    });

    this.context.on("page", (page) => this.trackPage(page));
    this.context.on("close", () => {
      if (!this.closing) {
        this.log.warn("Browser context closed unexpectedly");
        void this.close();
      }
    });

    const initial = this.context.pages()[0] ?? (await this.context.newPage());
    this.registerPage(initial, "main");

    // A site that redirects itself on load must not prevent the session from starting.
    await gotoTolerantOfRedirects(initial, this.startUrl, 45_000, (message) =>
      this.log.warn(message)
    );
    assertSafeLandedUrl(safeUrl(initial), this.options.urlSafety, this.startUrl);
    await this.applyConfigToAllPages();
  }

  private armTimeout(): void {
    this.timeoutTimer = setTimeout(() => {
      this.log.warn("Browser session reached its maximum lifetime, closing");
      void this.close();
    }, this.options.timeoutMs);
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;

    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);

    try {
      await this.context?.close();
    } catch (err) {
      this.log.warn({ err }, "Error closing browser context");
    }

    // Kill in reverse order: websockify, x11vnc, then Xvfb.
    for (const proc of [...this.processes].reverse()) {
      try {
        await killManaged(proc);
      } catch (err) {
        this.log.warn({ err, process: proc.name }, "Error killing session process");
      }
    }
    this.processes.length = 0;

    if (this.profileDir) {
      try {
        await rm(this.profileDir, { recursive: true, force: true, maxRetries: 3 });
      } catch (err) {
        this.log.warn({ err }, "Error removing session profile directory");
      }
      this.profileDir = null;
    }

    if (this.state !== "error") this.state = "closed";
    this.log.info("Browser session closed");
    this.options.onClosed(this.sessionId);
  }

  // ---- page tracking ------------------------------------------------------

  private registerPage(page: Page, pageId: string): void {
    this.pages.push({ pageId, page });
    this.activePageId = pageId;

    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      if (!this.recording) return;
      const url = frame.url();
      if (!url || url === "about:blank") return;
      // A navigation right after a click/submit is the consequence of that
      // action, so recording a separate goto would duplicate the step.
      if (Date.now() - this.lastActionAt < NAVIGATION_DEBOUNCE_MS) return;
      this.pushAction({ kind: "navigate", url, pageId, timestamp: Date.now() });
    });

    page.on("download", (download) => {
      if (!this.recording) return;
      // The click that opened the download was already recorded: upgrade it to a
      // download step instead of emitting a second, unrelated one.
      const last = this.actions[this.actions.length - 1];
      if (last && last.kind === "click") {
        this.actions[this.actions.length - 1] = {
          ...last,
          kind: "download",
          value: download.suggestedFilename()
        };
      } else {
        this.pushAction({
          kind: "download",
          value: download.suggestedFilename(),
          pageId,
          timestamp: Date.now()
        });
      }
    });

    page.on("close", () => {
      const index = this.pages.findIndex((p) => p.page === page);
      if (index >= 0) this.pages.splice(index, 1);
      if (this.activePageId === pageId) {
        this.activePageId = this.pages[this.pages.length - 1]?.pageId ?? "main";
      }
    });
  }

  private trackPage(page: Page): void {
    if (this.pages.some((p) => p.page === page)) return;
    this.nextTabIndex += 1;
    const pageId = `tab-${this.nextTabIndex}`;
    this.registerPage(page, pageId);

    if (this.recording) {
      this.pushAction({ kind: "newTab", value: pageId, pageId, timestamp: Date.now() });
    }
    void page
      .waitForLoadState("domcontentloaded", { timeout: 15_000 })
      .then(() => this.applyConfigToPage(page))
      .catch(() => undefined);
  }

  private pageIdOf(page: Page): string {
    return this.pages.find((p) => p.page === page)?.pageId ?? "main";
  }

  getPage(pageId: string): Page | null {
    return this.pages.find((p) => p.pageId === pageId)?.page ?? null;
  }

  getActivePage(): Page | null {
    return this.getPage(this.activePageId) ?? this.pages[0]?.page ?? null;
  }

  setActivePage(pageId: string): boolean {
    if (!this.pages.some((p) => p.pageId === pageId)) return false;
    this.activePageId = pageId;
    return true;
  }

  listPages(): Array<{ pageId: string; url: string; active: boolean }> {
    return this.pages.map((p) => ({
      pageId: p.pageId,
      url: safeUrl(p.page),
      active: p.pageId === this.activePageId
    }));
  }

  get currentUrl(): string | null {
    const page = this.getActivePage();
    return page ? safeUrl(page) : null;
  }

  // ---- recording ----------------------------------------------------------

  private handleEmittedAction(payload: Record<string, unknown>, page: Page): void {
    if (!this.recording) return;
    const parsed = RecordedActionSchema.safeParse({
      ...payload,
      pageId: this.pageIdOf(page),
      // Names a captured credential after the site, so recording a second site
      // cannot overwrite the first one's secret.
      pageUrl: safeUrl(page)
    });
    if (!parsed.success) {
      this.log.warn({ issues: parsed.error.issues }, "Discarded malformed recorded action");
      return;
    }
    this.pushAction(parsed.data);
  }

  private pushAction(action: RecordedAction): void {
    this.actions.push(action);
    this.lastActionAt = Date.now();

    if (action.isFinal) {
      // The closing action has been captured: nothing may follow it, so disarm and
      // stop recording straight away.
      this.armedFinal = false;
      this.recording = false;
      if (this.state === "running") this.state = "ready";
      void this.applyConfigToAllPages().catch(() => undefined);
      this.log.info("Captured the closing action without performing it; recording stopped");
    }
  }

  /**
   * Arms the capture of a closing action. The next interaction in the page is
   * recorded and suppressed, so a destructive final step (confirming an order)
   * never happens while recording.
   */
  async setArmedFinal(enabled: boolean): Promise<void> {
    // The more specific reason first: once a closing action exists, whether
    // recording is running is beside the point.
    if (enabled && this.actions.some((a) => a.isFinal)) {
      throw new Error("This recording already has a closing action");
    }
    if (enabled && !this.recording) {
      throw new Error("Start recording before arming the closing action");
    }
    this.armedFinal = enabled;
    await this.applyConfigToAllPages();
  }

  async setRecording(enabled: boolean): Promise<void> {
    if (enabled && this.actions.some((a) => a.isFinal)) {
      // Anything recorded now would come after the closing action, which can only
      // be the last step, so the workflow could never be saved.
      throw new Error(
        "This recording is closed by a closing action; delete it before recording more steps"
      );
    }
    if (enabled && !this.recording) {
      this.recording = true;
      // Seed the workflow with the page the user starts from, so a replay does
      // not depend on the browser's initial URL.
      if (this.actions.length === 0) {
        const url = this.currentUrl;
        if (url && url !== "about:blank") {
          this.pushAction({
            kind: "navigate",
            url,
            pageId: this.activePageId,
            timestamp: Date.now()
          });
        }
      }
      this.state = "running";
    } else if (!enabled) {
      this.recording = false;
      if (this.state === "running") this.state = "ready";
    }
    await this.applyConfigToAllPages();
  }

  async setHighlight(enabled: boolean): Promise<void> {
    this.highlight = enabled;
    await this.applyConfigToAllPages();
  }

  /** Records an explicit manual wait requested from the UI. */
  addManualWait(ms: number): void {
    this.pushAction({
      kind: "wait",
      value: String(ms),
      pageId: this.activePageId,
      timestamp: Date.now()
    });
  }

  private async applyConfigToPage(page: Page): Promise<void> {
    const config = {
      recording: this.recording,
      highlight: this.highlight,
      armedFinal: this.armedFinal
    };
    try {
      for (const frame of page.frames()) {
        await frame
          .evaluate((cfg) => {
            const apply = (window as unknown as Record<string, any>).__recorderApply;
            if (typeof apply === "function") apply(cfg);
          }, config)
          .catch(() => undefined);
      }
    } catch (err) {
      this.log.debug({ err }, "Could not apply recorder config to page");
    }
  }

  private async applyConfigToAllPages(): Promise<void> {
    for (const tracked of this.pages) {
      await this.applyConfigToPage(tracked.page);
    }
  }

  getRecordedActions(): RecordedAction[] {
    return [...this.actions];
  }

  /**
   * Converts what has been recorded so far into steps. Credential values are
   * returned separately so the API can store them encrypted; the steps
   * themselves only ever contain {{credentials.x}} references.
   */
  buildRecording(): {
    actions: RecordedAction[];
    steps: Step[];
    credentials: Array<{ name: string; value: string }>;
    skipped: number;
  } {
    const result = actionsToSteps(this.actions);
    return {
      actions: [...this.actions],
      steps: result.steps,
      credentials: result.credentials,
      skipped: result.skipped.length
    };
  }

  /** Discards the recorded actions, which also unlocks recording again. */
  clearRecording(): void {
    this.actions.length = 0;
    this.armedFinal = false;
    void this.applyConfigToAllPages().catch(() => undefined);
  }

  // ---- navigation ---------------------------------------------------------

  async navigate(url: string): Promise<void> {
    const page = this.getActivePage();
    if (!page) throw new Error("Session has no open page");
    await gotoTolerantOfRedirects(page, url, 45_000, (message) => this.log.warn(message));
    assertSafeLandedUrl(safeUrl(page), this.options.urlSafety, url);
    await this.applyConfigToPage(page);
  }

  // ---- direct interaction -------------------------------------------------

  /**
   * Performs a real input action on the live session, as an alternative to
   * pointing and typing over the noVNC stream. The events are generated by the
   * browser itself, so the recorder observes them exactly as it observes a
   * human interacting through noVNC.
   */
  async interact(input: {
    kind: "click" | "fill" | "select" | "check" | "uncheck" | "press";
    selector?: string;
    value?: string;
    pageId?: string;
    frame?: string;
  }): Promise<void> {
    const page = input.pageId ? this.getPage(input.pageId) : this.getActivePage();
    if (!page) throw new Error(`No open page for pageId '${input.pageId ?? this.activePageId}'`);

    if (input.kind === "press") {
      if (!input.value) throw new Error("press requires a key in 'value'");
      if (input.selector) {
        await this.rootFor(page, input.frame).locator(input.selector).press(input.value, {
          timeout: 15_000
        });
      } else {
        await page.keyboard.press(input.value);
      }
      return;
    }

    if (!input.selector) throw new Error(`${input.kind} requires a selector`);
    const locator = this.rootFor(page, input.frame).locator(input.selector);

    switch (input.kind) {
      case "click":
        await locator.click({ timeout: 15_000 });
        return;
      case "fill":
        // Focus rather than click: typing already produces the input events the
        // recorder listens for, and a click would add a redundant step.
        await locator.focus({ timeout: 15_000 });
        await locator.fill("");
        await locator.pressSequentially(input.value ?? "", { delay: 10, timeout: 20_000 });
        return;
      case "select":
        await locator.selectOption(input.value ?? "", { timeout: 15_000 });
        return;
      case "check":
        await locator.check({ timeout: 15_000 });
        return;
      case "uncheck":
        await locator.uncheck({ timeout: 15_000 });
        return;
      default:
        throw new Error(`Unsupported interaction: ${String(input.kind)}`);
    }
  }

  private rootFor(page: Page, frame?: string) {
    return frame ? page.frameLocator(frame) : page;
  }

  /**
   * Describes one element of the live page: tag, role, accessible name, label,
   * id, placeholder, the proposed selector and the overlay colour currently
   * applied to it. This backs the "selected element" panel of the recorder.
   */
  async describeElement(
    selector: string,
    options: { pageId?: string; frame?: string } = {}
  ): Promise<Record<string, unknown> | null> {
    const page = options.pageId ? this.getPage(options.pageId) : this.getActivePage();
    if (!page) throw new Error("Session has no open page");

    const target = options.frame
      ? page.frames().find((f) => f !== page.mainFrame())
      : page.mainFrame();
    if (!target) throw new Error(`Frame '${options.frame}' is not present`);

    return target.evaluate((sel) => {
      const describe = (window as unknown as Record<string, any>).__recorderDescribe;
      return typeof describe === "function" ? describe(sel) : null;
    }, selector);
  }
}

function safeUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return "";
  }
}
