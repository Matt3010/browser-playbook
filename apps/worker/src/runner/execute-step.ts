import path from "path";
import type { Locator, Page } from "playwright";
import { assertSafeTargetUrl, renderTemplate, type TemplateContext } from "@app/shared";
import type { Step } from "@app/workflow-schema";
import { resolveUnique } from "./locator";
import { assertSafeLandedUrl, gotoTolerantOfRedirects } from "./navigation";
import { safeDownloadPath } from "./artifact-path";
import { deliverPointerAction } from "./pointer-action";
import type { BrowserSession } from "../session/session";

export interface StepExecutionContext {
  session: BrowserSession;
  templates: TemplateContext;
  urlSafety: { allowPrivateTargets: boolean; allowedHosts: string[] };
  uploadFixtureDir: string;
  artifactDir: string;
  executionId: string;
  /** Called for artifacts produced by a step (e.g. a downloaded file). */
  onArtifact: (artifact: { type: string; path: string }) => Promise<void>;
  log: (level: "info" | "warn" | "error", message: string) => Promise<void>;
}

export class StepExecutionError extends Error {
  constructor(message: string) {
    super(message);
  }
}

function renderValue(step: Step, ctx: StepExecutionContext): string {
  if (step.value === null || step.value === undefined) {
    throw new StepExecutionError(`Step '${step.name}' requires a value`);
  }
  try {
    return renderTemplate(step.value, ctx.templates);
  } catch (err) {
    throw new StepExecutionError((err as Error).message);
  }
}

/**
 * Resolves the page a step targets.
 *
 * If the recorded page is not open the step fails, exactly as an ambiguous
 * selector does. Falling back to whatever page happens to be active would run the
 * action against the wrong document — clicking the wrong button, typing into the
 * wrong form — and report success.
 */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function pageFor(step: Step, ctx: StepExecutionContext): Page {
  const page = ctx.session.getPage(step.pageId);
  if (!page) {
    const open = ctx.session
      .listPages()
      .map((p) => p.pageId)
      .join(", ");
    throw new StepExecutionError(
      `Step '${step.name}' targets page '${step.pageId}', which is not open ` +
        `(open pages: ${open || "none"}). The workflow stops instead of acting on another page.`
    );
  }

  // Finding a page under that id is not the same as finding the right page. Ids are
  // handed out in the order tabs appear, so a tab the recording never saw shifts the
  // numbering and `tab-1` comes to mean a different document — which accepts the
  // action in silence. `main` is exempt: it is the initial page, and its own origin
  // legitimately changes as the workflow navigates.
  if (step.pageOrigin && step.pageId !== "main") {
    const actual = originOf(page.url());
    if (actual && actual !== step.pageOrigin) {
      throw new StepExecutionError(
        `Step '${step.name}' targets page '${step.pageId}', which was recorded on ` +
          `${step.pageOrigin} but is now showing ${actual}. A tab the recording did not ` +
          `see has taken that number, so the workflow stops instead of acting on the ` +
          `wrong document.`
      );
    }
  }

  return page;
}

/** The runner's wrapper around the shared pointer delivery: it names the step in
 * the log so the operator can see which control needed the label click. */
async function withOverlayFallback(
  step: Step,
  ctx: StepExecutionContext,
  locator: Locator,
  action: (options: { timeout: number; force?: boolean }) => Promise<void>,
  desiredState?: boolean
): Promise<void> {
  await deliverPointerAction({
    page: pageFor(step, ctx),
    locator,
    timeoutMs: step.timeoutMs,
    action,
    desiredState,
    onFallback: (message) => ctx.log("warn", `'${step.name}': ${message}`)
  });
}

async function locatorFor(step: Step, ctx: StepExecutionContext) {
  if (!step.selector) {
    throw new StepExecutionError(`Step '${step.name}' has no selector`);
  }
  const page = pageFor(step, ctx);
  const { locator, usedFallback } = await resolveUnique(page, step.selector, step.timeoutMs);
  if (usedFallback) {
    await ctx.log("warn", `Primary selector missed; used the recorded fallback for '${step.name}'`);
  }
  return locator;
}

/**
 * Executes a single step. Every failure throws, which makes the runner stop the
 * whole execution: the MVP never retries and never skips ahead.
 */
export async function executeStep(step: Step, ctx: StepExecutionContext): Promise<void> {
  switch (step.type) {
    case "goto": {
      const url = renderValue(step, ctx);
      assertSafeTargetUrl(url, {
        allowPrivateTargets: ctx.urlSafety.allowPrivateTargets,
        allowedHosts: ctx.urlSafety.allowedHosts
      });
      const page = pageFor(step, ctx);
      await gotoTolerantOfRedirects(page, url, step.timeoutMs, (message) =>
        ctx.log("warn", `'${step.name}': ${message}`)
      );
      // The page may have redirected the browser somewhere else entirely.
      assertSafeLandedUrl(page.url(), ctx.urlSafety, url);
      return;
    }

    case "click": {
      const locator = await locatorFor(step, ctx);
      await withOverlayFallback(step, ctx, locator, (options) => locator.click(options));
      return;
    }

    case "fill": {
      const locator = await locatorFor(step, ctx);
      await locator.fill(renderValue(step, ctx), { timeout: step.timeoutMs });
      return;
    }

    case "select": {
      const locator = await locatorFor(step, ctx);
      const value = renderValue(step, ctx);
      const selected = await locator.selectOption(value, { timeout: step.timeoutMs });
      if (selected.length === 0) {
        throw new StepExecutionError(
          `Option '${value}' is not available in the select targeted by '${step.name}'`
        );
      }
      return;
    }

    case "check": {
      const locator = await locatorFor(step, ctx);
      await withOverlayFallback(step, ctx, locator, (options) => locator.check(options), true);
      return;
    }

    case "uncheck": {
      const locator = await locatorFor(step, ctx);
      await withOverlayFallback(step, ctx, locator, (options) => locator.uncheck(options), false);
      return;
    }

    case "press": {
      const key = renderValue(step, ctx);
      if (step.selector) {
        const locator = await locatorFor(step, ctx);
        await locator.press(key, { timeout: step.timeoutMs });
      } else {
        const page = pageFor(step, ctx);
        await page.keyboard.press(key);
      }
      return;
    }

    case "wait": {
      const ms = Number(renderValue(step, ctx));
      if (!Number.isFinite(ms) || ms < 0 || ms > 120_000) {
        throw new StepExecutionError(`Invalid wait duration for '${step.name}'`);
      }
      await pageFor(step, ctx).waitForTimeout(ms);
      return;
    }

    case "waitForElement": {
      const locator = await locatorFor(step, ctx);
      await locator.waitFor({ state: "visible", timeout: step.timeoutMs });
      return;
    }

    case "assertVisible": {
      const locator = await locatorFor(step, ctx);
      const visible = await locator.isVisible({ timeout: step.timeoutMs });
      if (!visible) {
        throw new StepExecutionError(`Assertion failed: element for '${step.name}' is not visible`);
      }
      return;
    }

    case "assertText": {
      const locator = await locatorFor(step, ctx);
      const expected = renderValue(step, ctx);
      const actual = ((await locator.textContent({ timeout: step.timeoutMs })) ?? "")
        .trim()
        .replace(/\s+/g, " ");
      if (!actual.includes(expected.trim())) {
        throw new StepExecutionError(
          `Assertion failed: expected text '${expected}' but found '${actual}'`
        );
      }
      return;
    }

    case "switchPage": {
      const target = renderValue(step, ctx);
      // A tab opened by the previous click may still be attaching.
      const deadline = Date.now() + step.timeoutMs;
      while (Date.now() < deadline) {
        if (ctx.session.setActivePage(target)) {
          const page = ctx.session.getPage(target);
          await page?.waitForLoadState("domcontentloaded", { timeout: step.timeoutMs });
          await page?.bringToFront();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      const known = ctx.session
        .listPages()
        .map((p) => p.pageId)
        .join(", ");
      throw new StepExecutionError(
        `Page '${target}' is not open (open pages: ${known || "none"})`
      );
    }

    case "download": {
      const page = pageFor(step, ctx);
      const locator = await locatorFor(step, ctx);
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: step.timeoutMs }),
        locator.click({ timeout: step.timeoutMs })
      ]);
      const filename = download.suggestedFilename();
      // The name comes from the visited site, so it must not be trusted as a path.
      const target = safeDownloadPath(ctx.artifactDir, ctx.executionId, filename);
      await download.saveAs(target);
      await ctx.onArtifact({ type: "download", path: target });
      await ctx.log("info", `Downloaded ${filename}`);
      return;
    }

    case "upload": {
      const locator = await locatorFor(step, ctx);
      const requested = renderValue(step, ctx);
      // Only files from the configured fixture directory may be uploaded, so a
      // workflow can never exfiltrate arbitrary files from the worker.
      const resolved = path.resolve(ctx.uploadFixtureDir, path.basename(requested));
      if (!resolved.startsWith(path.resolve(ctx.uploadFixtureDir))) {
        throw new StepExecutionError(`Upload path '${requested}' is outside the fixture directory`);
      }
      await locator.setInputFiles(resolved, { timeout: step.timeoutMs });
      return;
    }

    default: {
      const exhaustive: never = step.type;
      throw new StepExecutionError(`Unsupported step type: ${String(exhaustive)}`);
    }
  }
}
