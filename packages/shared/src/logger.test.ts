import { describe, expect, it } from "vitest";
import { maskSecrets } from "./logger";

describe("maskSecrets", () => {
  it("removes secret values from free-form text", () => {
    expect(maskSecrets("login failed for TestPassword123!", ["TestPassword123!"])).toBe(
      "login failed for ***"
    );
  });

  it("masks every occurrence", () => {
    expect(maskSecrets("a s b s", ["s"])).toBe("a s b s"); // too short to mask
    expect(maskSecrets("a sec b sec", ["sec"])).toBe("a *** b ***");
  });

  it("ignores empty secrets", () => {
    expect(maskSecrets("unchanged", ["", "ab"])).toBe("unchanged");
  });
});
