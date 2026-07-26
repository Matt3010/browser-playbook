import { describe, expect, it } from "vitest";
import { renderTemplate, extractTemplateRefs, isSecretTemplate } from "./template";

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
