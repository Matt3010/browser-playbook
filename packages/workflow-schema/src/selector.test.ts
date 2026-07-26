import { describe, expect, it } from "vitest";
import { chooseSelector, describeSelector, buildFallback, type ElementInfo } from "./selector";

const base: ElementInfo = { tag: "input" };

describe("selector generation priority", () => {
  it("prefers role + accessible name when unique", () => {
    const sel = chooseSelector({
      ...base,
      tag: "button",
      role: "button",
      accessibleName: "Continua",
      text: "Continua",
      id: "submit-btn",
      cssPath: "form > button",
      unique: { role: true, text: true, id: true }
    });
    expect(sel).not.toBeNull();
    expect(sel!.strategy).toBe("role");
    expect(sel!.role).toBe("button");
    expect(sel!.name).toBe("Continua");
  });

  it("falls back to label when the role is ambiguous", () => {
    const sel = chooseSelector({
      ...base,
      role: "textbox",
      accessibleName: "Email",
      label: "Email",
      nameAttr: "email",
      unique: { role: false, label: true, name: true }
    });
    expect(sel!.strategy).toBe("label");
    expect(sel!.value).toBe("Email");
  });

  it("uses placeholder when role and label are unavailable", () => {
    const sel = chooseSelector({
      ...base,
      placeholder: "Il tuo nome",
      unique: { placeholder: true }
    });
    expect(sel!.strategy).toBe("placeholder");
    expect(sel!.value).toBe("Il tuo nome");
  });

  it("uses text only when unique", () => {
    const ambiguous = chooseSelector({
      ...base,
      tag: "a",
      text: "Dettagli",
      cssPath: "ul li:nth-child(3) > a",
      unique: { text: false }
    });
    expect(ambiguous!.strategy).toBe("css");

    const unique = chooseSelector({
      ...base,
      tag: "a",
      text: "Dettagli",
      cssPath: "ul li:nth-child(3) > a",
      unique: { text: true }
    });
    expect(unique!.strategy).toBe("text");
  });

  it("prefers data-testid over name and id", () => {
    const sel = chooseSelector({
      ...base,
      testId: "email-field",
      nameAttr: "email",
      id: "email",
      unique: { testid: true, name: true, id: true }
    });
    expect(sel!.strategy).toBe("testid");
  });

  it("prefers name over id", () => {
    const sel = chooseSelector({
      ...base,
      nameAttr: "email",
      id: "email",
      unique: { name: true, id: true }
    });
    expect(sel!.strategy).toBe("name");
  });

  it("uses xpath only as a last resort", () => {
    const sel = chooseSelector({
      ...base,
      xpath: "/html/body/div[2]/input",
      unique: { xpath: true }
    });
    expect(sel!.strategy).toBe("xpath");
  });

  it("returns null when nothing can identify the element", () => {
    expect(chooseSelector({ tag: "div" })).toBeNull();
    expect(chooseSelector({ tag: "div", text: "x", unique: { text: false } })).toBeNull();
  });

  it("stores a fallback distinct from the primary value", () => {
    const sel = chooseSelector({
      ...base,
      label: "Email",
      nameAttr: "email",
      unique: { label: true }
    });
    expect(sel!.strategy).toBe("label");
    expect(sel!.fallback).toBe("input[name='email']");
  });

  it("carries page and frame context", () => {
    const sel = chooseSelector({
      ...base,
      label: "Nome",
      unique: { label: true },
      pageId: "tab-2",
      frame: "#inner-frame"
    });
    expect(sel!.pageId).toBe("tab-2");
    expect(sel!.frame).toBe("#inner-frame");
  });

  it("defaults pageId to main", () => {
    const sel = chooseSelector({ ...base, label: "Nome", unique: { label: true } });
    expect(sel!.pageId).toBe("main");
  });
});

describe("buildFallback", () => {
  it("prefers a name attribute selector", () => {
    expect(buildFallback({ tag: "INPUT", nameAttr: "email" })).toBe("input[name='email']");
  });
  it("then id, then css, then xpath", () => {
    expect(buildFallback({ tag: "input", id: "email" })).toBe("#email");
    expect(buildFallback({ tag: "input", cssPath: "form input" })).toBe("form input");
    expect(buildFallback({ tag: "input", xpath: "//input" })).toBe("//input");
    expect(buildFallback({ tag: "input" })).toBeNull();
  });
});

describe("describeSelector", () => {
  it("describes role selectors", () => {
    expect(
      describeSelector({ strategy: "role", role: "button", name: "Login", pageId: "main" })
    ).toBe('role=button[name="Login"]');
  });
  it("describes value selectors", () => {
    expect(describeSelector({ strategy: "label", value: "Email", pageId: "main" })).toBe(
      "label=Email"
    );
  });
});
