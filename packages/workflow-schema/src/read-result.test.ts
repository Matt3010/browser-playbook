import { describe, expect, it } from "vitest";
import { classifyReadKind, classifyReadValue, parseLocaleNumber } from "./read-result";

describe("classifyReadKind", () => {
  it("reads a tick as a state, not as text", () => {
    expect(classifyReadKind("input", "checkbox")).toBe("checked");
    expect(classifyReadKind("input", "radio")).toBe("checked");
  });

  it("reads a field by its value", () => {
    expect(classifyReadKind("input", "text")).toBe("value");
    expect(classifyReadKind("input", null)).toBe("value");
    expect(classifyReadKind("input", "email")).toBe("value");
    expect(classifyReadKind("textarea", null)).toBe("value");
    expect(classifyReadKind("select", null)).toBe("value");
  });

  it("reads anything else by what it says", () => {
    expect(classifyReadKind("span", null)).toBe("text");
    expect(classifyReadKind("div", null)).toBe("text");
    expect(classifyReadKind("td", null)).toBe("text");
    expect(classifyReadKind("h1", null)).toBe("text");
  });

  it("is case-insensitive about the tag, because the DOM is not consistent", () => {
    expect(classifyReadKind("INPUT", "CHECKBOX")).toBe("checked");
    expect(classifyReadKind("SPAN", null)).toBe("text");
  });
});

describe("parseLocaleNumber", () => {
  it("reads a plain number", () => {
    expect(parseLocaleNumber("42")).toBe(42);
    expect(parseLocaleNumber("-3")).toBe(-3);
    expect(parseLocaleNumber("0")).toBe(0);
  });

  it("undresses a number of its currency and its percent", () => {
    expect(parseLocaleNumber("€ 12,30")).toBe(12.3);
    expect(parseLocaleNumber("12.30 €")).toBe(12.3);
    expect(parseLocaleNumber("$1,299.99")).toBe(1299.99);
    expect(parseLocaleNumber("42%")).toBe(42);
    expect(parseLocaleNumber("10,99%")).toBe(10.99);
  });

  it("undresses the non-breaking space a page separates its thousands with", () => {
    expect(parseLocaleNumber("1 234,56")).toBe(1234.56);
  });

  it("lets the last separator be the decimal one, whichever country wrote it", () => {
    expect(parseLocaleNumber("1.234,56")).toBe(1234.56);
    expect(parseLocaleNumber("1,234.56")).toBe(1234.56);
    expect(parseLocaleNumber("1.234.567,89")).toBe(1234567.89);
  });

  it("reads a lone separator with one or two decimals as a decimal", () => {
    expect(parseLocaleNumber("12,30")).toBe(12.3);
    expect(parseLocaleNumber("12.30")).toBe(12.3);
    expect(parseLocaleNumber("7,5")).toBe(7.5);
  });

  it("refuses to guess a country when the digits are ambiguous", () => {
    // "12,300" is twelve thousand three hundred in one place and twelve point
    // three in another, and nothing on the page says which. Answering wrongly
    // would be worse than not answering.
    expect(parseLocaleNumber("12,300")).toBeNull();
    expect(parseLocaleNumber("1.500")).toBeNull();
  });

  it("says nothing about text that is not a number", () => {
    for (const text of ["", "   ", "Sì", "abc", "12 pezzi", "-", ",", "1.2.3"]) {
      expect(parseLocaleNumber(text), text).toBeNull();
    }
  });
});

describe("classifyReadValue", () => {
  it("keeps a tick a boolean, and writes down what it was", () => {
    expect(classifyReadValue("checked", true)).toEqual({
      raw: "true",
      kind: "boolean",
      number: null,
      boolean: true
    });
    expect(classifyReadValue("checked", false)).toMatchObject({ kind: "boolean", boolean: false });
  });

  it("recognises a number and keeps the text it came from", () => {
    expect(classifyReadValue("text", "€ 1.234,56")).toEqual({
      raw: "€ 1.234,56",
      kind: "number",
      number: 1234.56,
      boolean: null
    });
  });

  it("never guesses a word into a boolean", () => {
    // Whether "Sì" means true is a decision for whoever compares it later, not
    // one this takes quietly on their behalf.
    for (const word of ["Sì", "No", "on", "off", "true", "false"]) {
      expect(classifyReadValue("text", word), word).toMatchObject({ kind: "text", raw: word });
    }
  });

  it("keeps an empty read as empty text rather than inventing something", () => {
    expect(classifyReadValue("value", "")).toMatchObject({ kind: "text", raw: "" });
  });

  it("collapses the whitespace a page uses for its own layout", () => {
    expect(classifyReadValue("text", "  Saldo\n   disponibile  ")).toMatchObject({
      raw: "Saldo disponibile"
    });
  });
});
