import { describe, expect, it } from "vitest";
import {
  chooseSelector,
  describeSelector,
  formatSelectorAsCode,
  buildFallback,
  isGeneratedId,
  MAX_TEXTUAL_SELECTOR_LENGTH,
  type ElementInfo
} from "./selector";

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

describe("selectors on real-world markup", () => {
  // The element that broke a workflow on a real storefront: a radio hidden
  // under its own label, whose accessible name embeds the price.
  const coveredRadio: ElementInfo = {
    tag: "input",
    type: "radio",
    role: "radio",
    accessibleName: '15" Nota 1 Da € 1.749,00 o € 57,26 al mese per 36 mesi, TAN fisso 10,99% Nota ①',
    label: '15" Nota 1 Da € 1.749,00 o € 57,26 al mese per 36 mesi, TAN fisso 10,99% Nota ①',
    nameAttr: "chassis-dimensionScreensize",
    valueAttr: "15inch",
    id: "_r_e_",
    cssPath: "fieldset > div:nth-of-type(2) > div > label > span",
    unique: { role: true, label: true, name: false, id: true }
  };

  it("shows the price-free selector the recorder actually stores", () => {
    // The recorder UI proposal and the stored selector are the same decision, so
    // they cannot disagree the way they used to.
    const sel = chooseSelector(coveredRadio)!;
    const shown = formatSelectorAsCode(sel);
    expect(shown).toContain(sel.value ?? "");
    expect(shown).not.toContain("1.749,00");
  });

  it("refuses a label or accessible name that embeds volatile content", () => {
    const sel = chooseSelector(coveredRadio);
    expect(sel).not.toBeNull();
    expect(sel!.strategy).not.toBe("label");
    expect(sel!.strategy).not.toBe("role");
    expect(JSON.stringify(sel)).not.toContain("1.749,00");
  });

  it("addresses a grouped radio by name and value", () => {
    const sel = chooseSelector(coveredRadio);
    expect(sel!.strategy).toBe("css");
    expect(sel!.value).toBe('input[name="chassis-dimensionScreensize"][value="15inch"]');
  });

  it("prefers name+value over the deep structural css path", () => {
    const sel = chooseSelector(coveredRadio);
    expect(sel!.value).not.toContain("nth-of-type");
    // The fallback would repeat the primary selector, so it is omitted.
    expect(sel!.fallback).toBeNull();
  });

  it("keeps a distinct structural fallback when the primary is textual", () => {
    const sel = chooseSelector({
      tag: "input",
      type: "radio",
      label: "Express",
      nameAttr: "shipping",
      valueAttr: "express",
      unique: { label: true }
    });
    expect(sel!.strategy).toBe("label");
    expect(sel!.fallback).toBe('input[name="shipping"][value="express"]');
  });

  it("still uses a short label when it is not volatile", () => {
    const sel = chooseSelector({
      tag: "input",
      type: "radio",
      label: "Express",
      nameAttr: "shipping",
      valueAttr: "express",
      unique: { label: true, name: false }
    });
    expect(sel!.strategy).toBe("label");
    expect(sel!.value).toBe("Express");
  });

  it("keeps a meaningful id but rejects framework-generated ones", () => {
    const meaningful = chooseSelector({
      tag: "input",
      id: "customer-email",
      unique: { id: true }
    });
    expect(meaningful!.strategy).toBe("id");
    expect(meaningful!.value).toBe("customer-email");

    for (const generated of ["_r_e_", ":r0:", "radix-:r1:", "mui-1234", "1234", "__", "el7"]) {
      const sel = chooseSelector({
        tag: "input",
        id: generated,
        cssPath: "form > input",
        unique: { id: true }
      });
      expect(sel!.strategy, `id '${generated}' must be rejected`).toBe("css");
    }
  });

  it("caps textual selectors at the documented length", () => {
    const long = "a".repeat(MAX_TEXTUAL_SELECTOR_LENGTH + 1);
    const short = "a".repeat(MAX_TEXTUAL_SELECTOR_LENGTH);
    expect(
      chooseSelector({ tag: "input", label: long, cssPath: "form > input", unique: { label: true } })!
        .strategy
    ).toBe("css");
    expect(
      chooseSelector({ tag: "input", label: short, cssPath: "form > input", unique: { label: true } })!
        .strategy
    ).toBe("label");
  });
});

describe("isGeneratedId", () => {
  it("detects generated ids", () => {
    for (const id of ["_r_e_", ":r0:", "radix-:r1:", "mui-1234", "42", "", "  ", "a1", "abc-12"]) {
      expect(isGeneratedId(id), id).toBe(true);
    }
  });

  it("accepts author-written ids", () => {
    for (const id of ["email", "customer-email", "fullname", "wizard-email", "download-link"]) {
      expect(isGeneratedId(id), id).toBe(false);
    }
  });

  /**
   * React's useId is a counter, and the id it produces is routinely suffixed by
   * the component using it, which is how a real site's radio labels turned out
   * to be identified. Recognising only the bare `_r_16_` form let `_r_16_--label`
   * through as a fallback, and the counter shifts with anything that renders
   * before it.
   */
  it("detects a generated id that carries a suffix", () => {
    for (const id of ["_r_16_--label", "_r_e_-input", "_r_1a_--description", ":r0:-label"]) {
      expect(isGeneratedId(id), id).toBe(true);
    }
  });

  it("does not mistake an author-written id that merely contains an r", () => {
    for (const id of ["user_r_name", "order_ref_2", "repository-name-input", "_private_note"]) {
      expect(isGeneratedId(id), id).toBe(false);
    }
  });
});

describe("buildFallback", () => {
  it("prefers a name attribute selector", () => {
    expect(buildFallback({ tag: "INPUT", nameAttr: "email" })).toBe("input[name='email']");
  });
  it("skips a generated id and falls through to the css path", () => {
    expect(buildFallback({ tag: "input", id: "_r_16_--label", cssPath: "form > label" })).toBe(
      "form > label"
    );
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

describe("formatSelectorAsCode", () => {
  it("reads as the Playwright call the runner will make", () => {
    expect(
      formatSelectorAsCode({ strategy: "role", role: "button", name: "Login", pageId: "main" })
    ).toBe("getByRole('button', { name: 'Login' })");
    expect(formatSelectorAsCode({ strategy: "label", value: "Email", pageId: "main" })).toBe(
      "getByLabel('Email')"
    );
    expect(formatSelectorAsCode({ strategy: "testid", value: "submit", pageId: "main" })).toBe(
      "getByTestId('submit')"
    );
    expect(formatSelectorAsCode({ strategy: "id", value: "email", pageId: "main" })).toBe("#email");
    expect(
      formatSelectorAsCode({ strategy: "css", value: 'input[name="a"][value="b"]', pageId: "main" })
    ).toBe('input[name="a"][value="b"]');
  });
});
