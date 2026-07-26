import { describe, expect, it } from "vitest";
import {
  buildHighlightCss,
  DEFAULT_RECORDER_COLORS,
  HIGHLIGHT_RULES,
  type HighlightCategory
} from "./highlight-css";

/** The colour scheme required by the MVP specification (section 3.4). */
const EXPECTED_COLORS: Record<HighlightCategory, string> = {
  input: "#f2c200", // yellow
  select: "#ff8c1a", // orange
  choice: "#8b5cf6", // purple
  button: "#e5484d", // red
  link: "#2f6fed", // blue
  clickable: "#22a06b", // green
  disabled: "#9aa3b2" // grey
};

/**
 * Returns the CSS block belonging to a category. Blocks are matched on their
 * full selector list, because a selector such as `:disabled` also occurs inside
 * the `:not(:disabled)` of other rules.
 */
function ruleFor(category: HighlightCategory): string {
  const rules = HIGHLIGHT_RULES.find((r) => r.category === category);
  if (!rules) throw new Error(`no rule for ${category}`);
  const expectedSelectors = rules.selectors.join(",\n");

  const blocks = buildHighlightCss()
    .split("}")
    .map((block) => `${block}}`.trim())
    .filter((block) => block.length > 1);

  const match = blocks.find((block) => block.startsWith(expectedSelectors));
  expect(match, `a CSS block for ${category} must exist`).toBeTruthy();
  return match as string;
}

describe("recorder overlay colours", () => {
  it("uses the documented colour for every element category", () => {
    for (const [category, color] of Object.entries(EXPECTED_COLORS) as Array<
      [HighlightCategory, string]
    >) {
      expect(DEFAULT_RECORDER_COLORS[category], category).toBe(color);
      expect(ruleFor(category), category).toContain(color);
    }
  });

  it("highlights text inputs and textareas in yellow, excluding other input types", () => {
    const rule = ruleFor("input");
    expect(rule).toContain("textarea:not(:disabled)");
    for (const excluded of ["checkbox", "radio", "submit", "button", "reset", "file"]) {
      expect(rule).toContain(`:not([type="${excluded}"])`);
    }
  });

  it("highlights checkboxes and radios in purple", () => {
    const rule = ruleFor("choice");
    expect(rule).toContain('input[type="checkbox"]');
    expect(rule).toContain('input[type="radio"]');
  });

  it("highlights non-standard clickable elements in green", () => {
    const rule = ruleFor("clickable");
    expect(rule).toContain('[role="button"]:not(button)');
    expect(rule).toContain("[onclick]");
    expect(rule).toContain('[tabindex]:not([tabindex="-1"])');
  });

  it("greys out disabled elements last so the rule wins over the others", () => {
    const css = buildHighlightCss();
    const disabledIndex = css.indexOf(":disabled,");
    const buttonIndex = css.indexOf("button:not(:disabled)");
    expect(disabledIndex).toBeGreaterThan(buttonIndex);
    expect(css).toContain('[aria-disabled="true"]');
  });

  it("only uses outline, so highlighting cannot change the page layout", () => {
    const css = buildHighlightCss();
    const declarations = css.match(/^\s+[a-z-]+:/gm) ?? [];
    const properties = new Set(declarations.map((d) => d.trim().replace(":", "")));
    expect([...properties].sort()).toEqual(["outline", "outline-offset"]);
  });

  it("never lets the tooltip highlight itself", () => {
    expect(buildHighlightCss(DEFAULT_RECORDER_COLORS, "my-tooltip")).toContain(
      "#my-tooltip {\n  outline: none !important;\n}"
    );
  });

  it("honours a custom palette", () => {
    const css = buildHighlightCss({ ...DEFAULT_RECORDER_COLORS, button: "#123456" });
    expect(css).toContain("#123456");
  });
});
