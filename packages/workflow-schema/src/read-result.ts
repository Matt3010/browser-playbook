/**
 * Reading a datum off the page, and deciding what kind of thing it is.
 *
 * An execution used to produce a status, an address and pictures. A workflow
 * that lands on a page showing a balance, an order number or a ticked box could
 * only *show* it in the screenshot: not readable, not comparable, not
 * searchable. A read step records it instead, under a name.
 *
 * The classification happens once, here, when the value is read — not every time
 * something wants to compare it. It is pure so it can be argued with in a unit
 * test rather than discovered in production at three in the morning.
 */

/** How an element gives up its datum. */
export type ReadKind = "value" | "checked" | "text";

/** What the read turned out to be. */
export type ReadValueType = "text" | "number" | "boolean";

export interface ClassifiedRead {
  /** What was on the page, whitespace collapsed. Kept whatever else is decided. */
  raw: string;
  kind: ReadValueType;
  /** Set only for a number. */
  number: number | null;
  /** Set only for a boolean, and only from a control that has a state. */
  boolean: boolean | null;
}

/** Fields carry a value, tickable controls carry a state, everything else says something. */
export function classifyReadKind(tag: string, type: string | null | undefined): ReadKind {
  const element = tag.toLowerCase();
  const inputType = (type ?? "").toLowerCase();
  if (element === "input" && (inputType === "checkbox" || inputType === "radio")) return "checked";
  if (element === "input" || element === "textarea" || element === "select") return "value";
  return "text";
}

// A page that separates its thousands with a non-breaking space is covered by
// \s, which in JavaScript includes U+00A0: writing the character itself here
// would be invisible to whoever reads this next, and the linter refuses it.
const CURRENCY_AND_PERCENT = /[€$£¥%\s]/g;

/**
 * The number inside a piece of text, whichever country wrote it, or null.
 *
 * Currency and percent are ornaments and come off. With two separators the last
 * one is the decimal point — that is true of both conventions. With one
 * separator followed by exactly three digits there is no way to tell
 * `12,300` (twelve thousand three hundred) from `12,300` (twelve point three
 * hundred), so nothing is returned: this codebase stops rather than guesses, and
 * a wrong number is worse than no number.
 */
export function parseLocaleNumber(input: string): number | null {
  const text = input.replace(CURRENCY_AND_PERCENT, "");
  if (text.length === 0) return null;
  if (!/^[+-]?[\d.,]+$/.test(text)) return null;

  const digitsOnly = text.replace(/[.,]/g, "");
  if (!/^[+-]?\d+$/.test(digitsOnly)) return null;

  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");
  const separators = (text.match(/[.,]/g) ?? []).length;

  if (separators === 0) return Number(text);

  const lastSeparator = Math.max(lastComma, lastDot);
  const decimals = text.length - lastSeparator - 1;

  // One separator and three digits after it: a thousands mark in one country and
  // a decimal in another, with nothing here able to tell them apart.
  if (separators === 1 && decimals === 3) return null;

  // Whatever is left of the decimal point must be grouped the way thousands are
  // grouped — 1.234.567 — or it is not a number at all: 1.2.3 is a version, an
  // address, a paragraph number, anything but an amount.
  const before = text.slice(0, lastSeparator);
  const groups = before.replace(/^[+-]/, "").split(/[.,]/);
  const grouped =
    groups.length === 1
      ? groups[0].length > 0
      : groups[0].length >= 1 &&
        groups[0].length <= 3 &&
        groups.slice(1).every((group) => group.length === 3);
  if (!grouped) return null;

  const whole = before.replace(/[.,]/g, "");
  const fraction = text.slice(lastSeparator + 1);
  const value = Number(`${whole}.${fraction}`);
  return Number.isFinite(value) ? value : null;
}

export function classifyReadValue(kind: ReadKind, read: string | boolean): ClassifiedRead {
  if (kind === "checked") {
    const state = read === true || read === "true";
    return { raw: String(state), kind: "boolean", number: null, boolean: state };
  }

  const raw = String(read).trim().replace(/\s+/g, " ");
  const numeric = parseLocaleNumber(raw);
  if (numeric !== null) {
    return { raw, kind: "number", number: numeric, boolean: null };
  }
  // A word is never turned into a boolean. Whether "Sì" means true is a decision
  // for whoever compares it later, made out loud, not one taken here in silence.
  return { raw, kind: "text", number: null, boolean: null };
}
