import path from "path";
import type { Page } from "playwright";
import { assertSafeTargetUrl, renderTemplate, type TemplateContext } from "@app/shared";
import type { Step } from "@app/workflow-schema";
import { resolveUnique } from "./locator";
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

function pageFor(step: Step, ctx: StepExecutionContext): Page {
  const page = ctx.session.getPage(step.pageId) ?? ctx.session.getActivePage();
  if (!page) throw new StepExecutionError(`No open page for pageId '${step.pageId}'`);
  return page;
}

/**
 * True when an action failed only because another element sits on top of the
 * target. The usual cause is a styled label covering its own hidden checkbox or
 * radio, which is a legitimate page design rather than a broken selector.
 */
function isPointerIntercepted(error: unknown): boolean {
  const message = (error as Error)?.message ?? "";
  return message.includes("intercepts pointer events");
}

/**
 * Performs a pointer action, and if the element turns out to be covered by its
 * own label, performs it again bypassing the hit-target check.
 *
 * This is not a retry of the step: the element was found and is the right one,
 * only the way the click is delivered changes. A genuinely missing or ambiguous
 * element still fails the workflow immediately.
 */
async function withOverlayFallback(
  step: Step,
  ctx: StepExecutionContext,
  action: (options: { timeout: number; force?: boolean }) => Promise<void>
): Promise<void> {
  try {
    await action({ timeout: step.timeoutMs });
  } catch (err) {
    if (!isPointerIntercepted(err)) throw err;
    await ctx.log(
      "warn",
      `'${step.name}': the element is covered by another one (typically its own label); ` +
        `delivering the action directly to it`
    );
    await action({ timeout: step.timeoutMs, force: true });
  }
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
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: step.timeoutMs });
      return;
    }

    case "click": {
      const locator = await locatorFor(step, ctx);
      await withOverlayFallback(step, ctx, (options) => locator.click(options));
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
      await withOverlayFallback(step, ctx, (options) => locator.check(options));
      return;
    }

    case "uncheck": {
      const locator = await locatorFor(step, ctx);
      await withOverlayFallback(step, ctx, (options) => locator.uncheck(options));
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
      const target = path.join(ctx.artifactDir, ctx.executionId, `download-${filename}`);
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
