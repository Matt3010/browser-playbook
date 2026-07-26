import { describe, expect, it } from "vitest";
import { encryptSecret, decryptSecret } from "./encryption";

const KEY = "0123456789abcdef0123456789abcdef";

describe("credential encryption", () => {
  it("round-trips a secret", () => {
    const plaintext = "TestPassword123!";
    const encrypted = encryptSecret(plaintext, KEY);
    expect(encrypted).not.toContain(plaintext);
    expect(decryptSecret(encrypted, KEY)).toBe(plaintext);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const a = encryptSecret("same-value", KEY);
    const b = encryptSecret("same-value", KEY);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, KEY)).toBe(decryptSecret(b, KEY));
  });

  it("fails to decrypt with the wrong key", () => {
    const encrypted = encryptSecret("secret", KEY);
    expect(() => decryptSecret(encrypted, "ffffffffffffffffffffffffffffffff")).toThrow();
  });

  it("fails to decrypt tampered ciphertext (auth tag check)", () => {
    const encrypted = encryptSecret("secret", KEY);
    const [iv, tag, data] = encrypted.split(":");
    const flipped = data.startsWith("a") ? `b${data.slice(1)}` : `a${data.slice(1)}`;
    expect(() => decryptSecret(`${iv}:${tag}:${flipped}`, KEY)).toThrow();
  });

  it("rejects malformed payloads", () => {
    expect(() => decryptSecret("not-a-payload", KEY)).toThrow(/Invalid encrypted payload/);
  });

  it("handles unicode and empty strings", () => {
    expect(decryptSecret(encryptSecret("", KEY), KEY)).toBe("");
    expect(decryptSecret(encryptSecret("pàsswörd✓", KEY), KEY)).toBe("pàsswörd✓");
  });
});
