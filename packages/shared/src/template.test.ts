import { describe, expect, it } from "vitest";
import {
  extractTemplateRefs,
  findUnknownPlaceholders,
  isSecretTemplate,
  renderTemplate
} from "./template";

const ctx = {
  variables: { customerName: "Acme", city: "Roma" },
  credentials: { email: "test@example.com", password: "TestPassword123!" }
};

describe("variable rendering", () => {
  it("renders variables and credentials", () => {
    expect(renderTemplate("{{variables.customerName}}", ctx)).toBe("Acme");
    expect(renderTemplate("{{credentials.email}}", ctx)).toBe("test@example.com");
  });

  it("renders multiple references inside one string", () => {
    expect(renderTemplate("{{variables.customerName}} - {{variables.city}}", ctx)).toBe(
      "Acme - Roma"
    );
  });

  it("tolerates internal whitespace", () => {
    expect(renderTemplate("{{ variables.city }}", ctx)).toBe("Roma");
  });

  it("leaves plain strings untouched", () => {
    expect(renderTemplate("no placeholders", ctx)).toBe("no placeholders");
  });

  it("throws on unknown references instead of silently emitting empty text", () => {
    expect(() => renderTemplate("{{variables.missing}}", ctx)).toThrow(/Unknown template reference/);
    expect(() => renderTemplate("{{credentials.missing}}", ctx)).toThrow(
      /Unknown template reference/
    );
  });

  it("extracts references", () => {
    expect(extractTemplateRefs("{{variables.a}}{{credentials.b}}")).toEqual([
      { kind: "variables", key: "a" },
      { kind: "credentials", key: "b" }
    ]);
  });

  it("detects secret templates", () => {
    expect(isSecretTemplate("{{credentials.password}}")).toBe(true);
    expect(isSecretTemplate("{{variables.city}}")).toBe(false);
    expect(isSecretTemplate("literal")).toBe(false);
  });
});

describe("findUnknownPlaceholders", () => {
  // renderTemplate leaves anything it does not recognise alone, so a mistyped
  // reference is typed into the page verbatim. In a password field that is a failed
  // login attempt on every run, and enough of them lock the account.
  it("catches a reference that names a kind that does not exist", () => {
    expect(findUnknownPlaceholders("{{secret.password}}")).toEqual(["{{secret.password}}"]);
    expect(findUnknownPlaceholders("{{credential.email}}")).toEqual(["{{credential.email}}"]);
    expect(findUnknownPlaceholders("{{password}}")).toEqual(["{{password}}"]);
  });

  it("accepts the two real kinds, with or without spaces", () => {
    expect(findUnknownPlaceholders("{{credentials.password_apple}}")).toEqual([]);
    expect(findUnknownPlaceholders("{{ variables.email }}")).toEqual([]);
    expect(findUnknownPlaceholders("Ciao {{variables.nome}}, entra")).toEqual([]);
  });

  it("says nothing about text that has no placeholder", () => {
    expect(findUnknownPlaceholders("https://example.com/login")).toEqual([]);
    expect(findUnknownPlaceholders("")).toEqual([]);
    expect(findUnknownPlaceholders('{"json": 1}')).toEqual([]);
  });

  it("reports every offender, once each", () => {
    expect(findUnknownPlaceholders("{{secret.a}} e {{secret.a}} e {{credentials.b}}")).toEqual([
      "{{secret.a}}"
    ]);
  });
});
