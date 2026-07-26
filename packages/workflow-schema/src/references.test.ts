import { describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { StepSchema, type Step } from "./step";
import { findMissingReferences, describeMissingReferences } from "./references";

function fill(name: string, value: string, enabled = true): Step {
  return StepSchema.parse({
    id: randomUUID(),
    type: "fill",
    name,
    selector: { strategy: "label", value: "Campo", pageId: "main" },
    value,
    timeoutMs: 10000,
    enabled
  });
}

const nothing = { variables: [], credentials: [] };

describe("findMissingReferences", () => {
  it("reports a credential the workflow uses but does not exist", () => {
    const missing = findMissingReferences(
      [fill("Inserisci Password", "{{credentials.password}}")],
      nothing
    );
    expect(missing).toEqual([
      { kind: "credentials", name: "password", steps: ["Inserisci Password"] }
    ]);
  });

  it("reports a missing variable", () => {
    const missing = findMissingReferences(
      [fill("Inserisci Nome", "{{variables.customerName}}")],
      { variables: ["city"], credentials: [] }
    );
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ kind: "variables", name: "customerName" });
  });

  it("returns nothing when every reference resolves", () => {
    const missing = findMissingReferences(
      [
        fill("Email", "{{credentials.email}}"),
        fill("Nome", "{{variables.customerName}}"),
        fill("Letterale", "testo fisso")
      ],
      { variables: ["customerName"], credentials: ["email"] }
    );
    expect(missing).toEqual([]);
  });

  it("does not confuse the two namespaces", () => {
    // A variable named `password` must not satisfy {{credentials.password}}.
    const missing = findMissingReferences([fill("Password", "{{credentials.password}}")], {
      variables: ["password"],
      credentials: []
    });
    expect(missing).toHaveLength(1);
    expect(missing[0].kind).toBe("credentials");
  });

  it("groups every step that uses the same missing reference", () => {
    const missing = findMissingReferences(
      [fill("Primo", "{{credentials.token}}"), fill("Secondo", "{{credentials.token}}")],
      nothing
    );
    expect(missing).toHaveLength(1);
    expect(missing[0].steps).toEqual(["Primo", "Secondo"]);
  });

  it("ignores disabled steps, which are never executed", () => {
    expect(
      findMissingReferences([fill("Disabilitato", "{{credentials.password}}", false)], nothing)
    ).toEqual([]);
  });

  it("handles several references inside one value", () => {
    const missing = findMissingReferences(
      [fill("Composto", "{{variables.a}} - {{credentials.b}}")],
      nothing
    );
    expect(missing.map((m) => `${m.kind}.${m.name}`).sort()).toEqual([
      "credentials.b",
      "variables.a"
    ]);
  });

  it("ignores steps without a value", () => {
    const click = StepSchema.parse({
      id: randomUUID(),
      type: "click",
      name: "Clicca",
      selector: { strategy: "label", value: "Ok", pageId: "main" },
      timeoutMs: 10000
    });
    expect(findMissingReferences([click], nothing)).toEqual([]);
  });
});

describe("describeMissingReferences", () => {
  it("names the reference and the steps that use it", () => {
    const text = describeMissingReferences(
      findMissingReferences([fill("Inserisci Password", "{{credentials.password}}")], nothing)
    );
    expect(text).toContain("{{credentials.password}}");
    expect(text).toContain("Inserisci Password");
  });

  it("joins several missing references", () => {
    const text = describeMissingReferences(
      findMissingReferences(
        [fill("Uno", "{{credentials.a}}"), fill("Due", "{{variables.b}}")],
        nothing
      )
    );
    expect(text).toContain("credentials.a");
    expect(text).toContain("variables.b");
    expect(text).toContain(";");
  });
});
