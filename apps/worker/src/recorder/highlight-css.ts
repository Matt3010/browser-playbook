/**
 * Colour scheme and stylesheet for the recorder overlay.
 *
 * The CSS is built here (in Node) and passed to the injected script as data, so
 * the mapping between element categories and colours is unit-testable without a
 * browser, while the injected script stays self-contained.
 */
export interface RecorderColors {
  input: string;
  select: string;
  choice: string;
  button: string;
  link: string;
  clickable: string;
  disabled: string;
}

export const DEFAULT_RECORDER_COLORS: RecorderColors = {
  input: "#f2c200", // input, textarea -> yellow
  select: "#ff8c1a", // select -> orange
  choice: "#8b5cf6", // checkbox, radio -> purple
  button: "#e5484d", // button -> red
  link: "#2f6fed", // link -> blue
  clickable: "#22a06b", // non-standard clickable -> green
  disabled: "#9aa3b2" // disabled -> grey
};

export type HighlightCategory = keyof RecorderColors;

/**
 * Selectors per category, in cascade order. Later rules win, so `disabled`
 * comes last and greys out any control regardless of its type.
 */
export const HIGHLIGHT_RULES: Array<{ category: HighlightCategory; selectors: string[] }> = [
  {
    category: "input",
    selectors: [
      'input:not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="file"]):not(:disabled)',
      "textarea:not(:disabled)"
    ]
  },
  { category: "select", selectors: ["select:not(:disabled)"] },
  {
    category: "choice",
    selectors: ['input[type="checkbox"]:not(:disabled)', 'input[type="radio"]:not(:disabled)']
  },
  {
    category: "button",
    selectors: [
      "button:not(:disabled)",
      'input[type="submit"]:not(:disabled)',
      'input[type="button"]:not(:disabled)',
      'input[type="reset"]:not(:disabled)'
    ]
  },
  { category: "link", selectors: ["a[href]"] },
  {
    category: "clickable",
    selectors: [
      '[role="button"]:not(button)',
      '[role="link"]:not(a)',
      "[onclick]",
      'input[type="file"]:not(:disabled)',
      '[tabindex]:not([tabindex="-1"]):not(input):not(select):not(textarea):not(button):not(a)'
    ]
  },
  { category: "disabled", selectors: [":disabled", '[aria-disabled="true"]'] }
];

/**
 * Builds the overlay stylesheet. Only `outline` is used: it does not take part
 * in layout, so highlighting can never shift or reflow the page.
 */
export function buildHighlightCss(
  colors: RecorderColors = DEFAULT_RECORDER_COLORS,
  tooltipId = "__recorder_tooltip__"
): string {
  const blocks = HIGHLIGHT_RULES.map(({ category, selectors }) => {
    const offset = category === "choice" ? 2 : 1;
    return `${selectors.join(",\n")} {\n  outline: 2px solid ${colors[category]} !important;\n  outline-offset: ${offset}px !important;\n}`;
  });
  blocks.push(`#${tooltipId} {\n  outline: none !important;\n}`);
  return blocks.join("\n");
}
