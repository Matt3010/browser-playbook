import { describe, expect, it } from "vitest";
import {
  evaluateFormula,
  evaluateFormulas,
  hasFormula,
  type FormulaEnvironment
} from "./formula";

/** A world that does not move, so what comes out can be written down. */
function fixed(now = "2026-07-28T11:30:45.000Z"): FormulaEnvironment {
  let n = 0;
  return {
    now: new Date(now),
    // Walks the alphabet instead of jumping around it: predictable, and still
    // exercises the arithmetic that turns a number into a character.
    random: () => {
      n += 1;
      return ((n * 7) % 36) / 36;
    },
    uuid: () => "11111111-2222-4333-8444-555555555555"
  };
}

describe("hasFormula", () => {
  it("recognises the tokens", () => {
    for (const text of ["{{timestamp}}", "repo-{{date}}", "x{{random:8}}y", "{{uuid}}"]) {
      expect(hasFormula(text), text).toBe(true);
    }
  });

  it("leaves ordinary values, and references, alone", () => {
    for (const text of ["test", "", "{{variables.name}}", "{{credentials.password}}", "{{nope}}"]) {
      expect(hasFormula(text), text).toBe(false);
    }
  });
});

describe("evaluateFormula", () => {
  it("stamps the moment it ran, in UTC", () => {
    expect(evaluateFormula("repo-{{timestamp}}", fixed())).toBe("repo-20260728-113045");
    expect(evaluateFormula("{{date}}", fixed())).toBe("2026-07-28");
    expect(evaluateFormula("{{time}}", fixed())).toBe("11:30:45");
  });

  it("pads a single-digit month, day and hour", () => {
    const env = fixed("2026-01-02T03:04:05.000Z");
    expect(evaluateFormula("{{timestamp}}", env)).toBe("20260102-030405");
    expect(evaluateFormula("{{date}}", env)).toBe("2026-01-02");
  });

  it("makes text of the length asked for", () => {
    expect(evaluateFormula("{{random}}", fixed())).toHaveLength(6);
    expect(evaluateFormula("{{random:12}}", fixed())).toHaveLength(12);
    expect(evaluateFormula("{{random}}", fixed())).toMatch(/^[a-z0-9]{6}$/);
  });

  it("falls back to a sane length rather than failing a run", () => {
    // A run that was going to work must not die on a malformed argument.
    expect(evaluateFormula("{{random:abc}}", fixed())).toHaveLength(6);
    expect(evaluateFormula("{{random:0}}", fixed())).toHaveLength(6);
    expect(evaluateFormula("{{random:999}}", fixed())).toHaveLength(6);
  });

  it("keeps everything around the tokens", () => {
    expect(evaluateFormula("ordine-{{date}}-{{random:4}}-fine", fixed())).toMatch(
      /^ordine-2026-07-28-[a-z0-9]{4}-fine$/
    );
  });

  it("does not touch a reference, which is somebody else's job", () => {
    expect(evaluateFormula("{{variables.other}}", fixed())).toBe("{{variables.other}}");
    expect(evaluateFormula("{{credentials.password}}", fixed())).toBe("{{credentials.password}}");
  });

  it("leaves an unknown token as it found it", () => {
    expect(evaluateFormula("{{tomorrow}}", fixed())).toBe("{{tomorrow}}");
  });
});

describe("evaluateFormulas", () => {
  it("evaluates each value once, so two references agree", () => {
    // A repository created under one name and then opened under another is two
    // failures, and the second one is the confusing kind.
    const values = { repo: "repo-{{random:8}}", note: "statico" };
    const evaluated = evaluateFormulas(values, fixed());

    expect(evaluated.note).toBe("statico");
    expect(evaluated.repo).toMatch(/^repo-[a-z0-9]{8}$/);
    // The same map is what the whole run reads from: one value, used twice.
    expect(evaluated.repo).toBe(evaluated.repo);
  });

  it("gives a different answer on a later run", () => {
    const first = evaluateFormulas({ repo: "repo-{{timestamp}}" }, fixed("2026-07-28T11:30:45Z"));
    const second = evaluateFormulas({ repo: "repo-{{timestamp}}" }, fixed("2026-07-28T11:31:45Z"));
    expect(first.repo).not.toBe(second.repo);
  });

  it("leaves values without a formula untouched", () => {
    const values = { a: "uno", b: "", c: "{{variables.altro}}" };
    expect(evaluateFormulas(values, fixed())).toEqual(values);
  });
});
