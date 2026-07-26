import { describe, expect, it } from "vitest";
import { actionToStep, actionsToSteps, credentialNameFromElement } from "./recorded-action";
import type { RecordedAction } from "./recorded-action";

let counter = 0;
const newId = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

function action(partial: Partial<RecordedAction>): RecordedAction {
  return {
    kind: "click",
    pageId: "main",
    timestamp: Date.now(),
    ...partial
  } as RecordedAction;
}

const emailField = {
  tag: "input",
  type: "email",
  role: "textbox",
  accessibleName: "Email",
  label: "Email",
  nameAttr: "email",
  unique: { role: true, label: true, name: true }
};

const passwordField = {
  tag: "input",
  type: "password",
  label: "Password",
  nameAttr: "password",
  unique: { label: true, name: true }
};

describe("recorded action to step conversion", () => {
  it("converts a navigation into a goto step", () => {
    const result = actionToStep(action({ kind: "navigate", url: "https://example.com/login" }), {
      newId
    });
    expect(result!.step.type).toBe("goto");
    expect(result!.step.value).toBe("https://example.com/login");
    expect(result!.step.name).toBe("Vai a https://example.com/login");
  });

  it("converts a fill into a fill step with a role selector", () => {
    const result = actionToStep(
      action({ kind: "fill", element: emailField, value: "test@example.com" }),
      { newId }
    );
    expect(result!.step.type).toBe("fill");
    expect(result!.step.selector!.strategy).toBe("role");
    expect(result!.step.value).toBe("test@example.com");
    expect(result!.credential).toBeUndefined();
  });

  it("turns a password input into a credential reference and never stores the literal in the step", () => {
    const result = actionToStep(
      action({
        kind: "fill",
        element: passwordField,
        value: "TestPassword123!",
        isPassword: true
      }),
      { newId }
    );
    expect(result!.step.value).toBe("{{credentials.password}}");
    expect(JSON.stringify(result!.step)).not.toContain("TestPassword123!");
    expect(result!.credential).toEqual({ name: "password", value: "TestPassword123!" });
  });

  it("maps every recorded kind to the expected step type", () => {
    const cases: Array<[RecordedAction, string]> = [
      [action({ kind: "click", element: emailField }), "click"],
      [action({ kind: "submit", element: emailField }), "click"],
      [action({ kind: "select", element: emailField, value: "IT" }), "select"],
      [action({ kind: "check", element: emailField }), "check"],
      [action({ kind: "uncheck", element: emailField }), "uncheck"],
      [action({ kind: "press", key: "Enter" }), "press"],
      [action({ kind: "wait", value: "500" }), "wait"],
      [action({ kind: "newTab", value: "tab-1" }), "switchPage"],
      [action({ kind: "switchTab", value: "main" }), "switchPage"],
      [action({ kind: "download", element: emailField }), "download"],
      [action({ kind: "upload", element: emailField, value: "/fixtures/a.txt" }), "upload"]
    ];
    for (const [input, expected] of cases) {
      const result = actionToStep(input, { newId });
      expect(result, `${input.kind} should convert`).not.toBeNull();
      expect(result!.step.type, input.kind).toBe(expected);
    }
  });

  it("marks a suppressed closing action as final and names it clearly", () => {
    const result = actionToStep(
      action({
        kind: "click",
        element: { tag: "button", role: "button", accessibleName: "Acquista", unique: { role: true } },
        isFinal: true
      }),
      { newId }
    );
    expect(result!.step.isFinal).toBe(true);
    expect(result!.step.name).toContain("azione finale");
  });

  it("leaves ordinary actions unmarked", () => {
    const result = actionToStep(
      action({
        kind: "click",
        element: { tag: "button", role: "button", accessibleName: "Continua", unique: { role: true } }
      }),
      { newId }
    );
    expect(result!.step.isFinal).toBe(false);
  });

  it("keeps the value attribute, so a grouped radio stays addressable", () => {
    // The schema strips undeclared keys, so a missing field here silently
    // degrades every selector built for a radio group.
    const result = actionToStep(
      action({
        kind: "check",
        element: {
          tag: "input",
          type: "radio",
          nameAttr: "size-choice",
          valueAttr: "15inch",
          unique: { name: false }
        }
      }),
      { newId }
    );
    expect(result).not.toBeNull();
    expect(result!.step.selector!.strategy).toBe("css");
    expect(result!.step.selector!.value).toBe('input[name="size-choice"][value="15inch"]');
  });

  it("keeps the suggested filename on a download step", () => {
    const result = actionToStep(
      action({ kind: "download", element: emailField, value: "sample.txt" }),
      { newId }
    );
    expect(result!.step.type).toBe("download");
    expect(result!.step.value).toBe("sample.txt");
  });

  it("keeps the file name on an upload step", () => {
    const result = actionToStep(
      action({ kind: "upload", element: emailField, value: "fixture.txt" }),
      { newId }
    );
    expect(result!.step.value).toBe("fixture.txt");
  });

  it("refuses to record an action whose element has no unique selector", () => {
    const ambiguous = { tag: "button", text: "OK", unique: { text: false } };
    expect(actionToStep(action({ kind: "click", element: ambiguous }), { newId })).toBeNull();
  });

  it("preserves the logical page id", () => {
    const result = actionToStep(
      action({ kind: "click", element: emailField, pageId: "tab-2" }),
      { newId }
    );
    expect(result!.step.pageId).toBe("tab-2");
    expect(result!.step.selector!.pageId).toBe("tab-2");
  });

  it("derives credential names from the field", () => {
    expect(credentialNameFromElement({ tag: "input", nameAttr: "user-password" })).toBe(
      "user_password"
    );
    expect(credentialNameFromElement({ tag: "input", label: "Password" })).toBe("password");
    expect(credentialNameFromElement(null)).toBe("password");
  });
});

describe("action stream to step list", () => {
  it("builds an ordered login step list", () => {
    const result = actionsToSteps(
      [
        action({ kind: "navigate", url: "http://test-web:3001/login" }),
        action({ kind: "fill", element: emailField, value: "test@example.com" }),
        action({
          kind: "fill",
          element: passwordField,
          value: "TestPassword123!",
          isPassword: true
        }),
        action({
          kind: "click",
          element: {
            tag: "button",
            role: "button",
            accessibleName: "Login",
            unique: { role: true }
          }
        })
      ],
      { newId }
    );

    expect(result.steps.map((s) => s.type)).toEqual(["goto", "fill", "fill", "click"]);
    expect(result.credentials).toEqual([{ name: "password", value: "TestPassword123!" }]);
    expect(result.skipped).toHaveLength(0);
    expect(JSON.stringify(result.steps)).not.toContain("TestPassword123!");
  });

  it("collapses consecutive fills on the same field to the final value", () => {
    const result = actionsToSteps(
      [
        action({ kind: "fill", element: emailField, value: "t" }),
        action({ kind: "fill", element: emailField, value: "te" }),
        action({ kind: "fill", element: emailField, value: "test@example.com" })
      ],
      { newId }
    );
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].value).toBe("test@example.com");
  });

  it("does not collapse fills on different fields", () => {
    const result = actionsToSteps(
      [
        action({ kind: "fill", element: emailField, value: "a" }),
        action({ kind: "fill", element: passwordField, value: "b" })
      ],
      { newId }
    );
    expect(result.steps).toHaveLength(2);
  });

  it("de-duplicates repeated navigation to the same URL", () => {
    const result = actionsToSteps(
      [
        action({ kind: "navigate", url: "http://test-web:3001/login" }),
        action({ kind: "navigate", url: "http://test-web:3001/login" }),
        action({ kind: "navigate", url: "http://test-web:3001/dashboard" })
      ],
      { newId }
    );
    expect(result.steps).toHaveLength(2);
  });

  it("collects skipped actions instead of guessing a selector", () => {
    const result = actionsToSteps(
      [
        action({ kind: "navigate", url: "http://test-web:3001/login" }),
        action({ kind: "click", element: { tag: "div", text: "X", unique: { text: false } } })
      ],
      { newId }
    );
    expect(result.steps).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
  });
});

describe("credential naming across sites", () => {
  const passwordField = {
    tag: "input",
    type: "password",
    label: "Password",
    nameAttr: "password",
    unique: { label: true, name: true }
  };

  it("gives two different sites two different credential names", () => {
    // Every login form calls the field "password". Naming the credential after
    // the field alone means recording a second site overwrites the first site's
    // secret, and the first workflow then logs in with the wrong password.
    const first = actionToStep(
      action({
        kind: "fill",
        element: passwordField,
        value: "segreto-uno",
        isPassword: true,
        pageUrl: "https://shop.example.com/login"
      }),
      { newId }
    );
    const second = actionToStep(
      action({
        kind: "fill",
        element: passwordField,
        value: "segreto-due",
        isPassword: true,
        pageUrl: "https://banca.example.it/accedi"
      }),
      { newId }
    );

    expect(first!.credential!.name).not.toBe(second!.credential!.name);
    expect(first!.step.value).not.toBe(second!.step.value);
    expect(first!.credential!.name).toContain("shop_example_com");
    expect(second!.credential!.name).toContain("banca_example_it");
  });

  it("reuses the same name for the same site, so re-recording updates it", () => {
    const build = (value: string) =>
      actionToStep(
        action({
          kind: "fill",
          element: passwordField,
          value,
          isPassword: true,
          pageUrl: "https://shop.example.com/login"
        }),
        { newId }
      )!;

    expect(build("vecchia").credential!.name).toBe(build("nuova").credential!.name);
  });

  it("ignores the port and a www prefix, which are not part of the identity", () => {
    const name = (url: string) =>
      actionToStep(
        action({ kind: "fill", element: passwordField, value: "x", isPassword: true, pageUrl: url }),
        { newId }
      )!.credential!.name;

    expect(name("http://www.example.com/login")).toBe(name("https://example.com/other"));
    expect(name("http://example.com:8080/login")).toBe(name("http://example.com/login"));
  });

  it("keeps the field name in the credential, so it stays readable", () => {
    const result = actionToStep(
      action({
        kind: "fill",
        element: { ...passwordField, nameAttr: "otp_code" },
        value: "123",
        isPassword: true,
        pageUrl: "https://example.com/login"
      }),
      { newId }
    );
    expect(result!.credential!.name).toBe("otp_code_example_com");
    expect(result!.step.value).toBe("{{credentials.otp_code_example_com}}");
  });

  it("falls back to the field name when the page URL is unusable", () => {
    for (const url of [undefined, "", "not a url", "about:blank"]) {
      const result = actionToStep(
        action({
          kind: "fill",
          element: passwordField,
          value: "x",
          isPassword: true,
          pageUrl: url
        }),
        { newId }
      );
      expect(result!.credential!.name, String(url)).toBe("password");
    }
  });
});
