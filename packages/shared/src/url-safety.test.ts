import { describe, expect, it } from "vitest";
import { assertSafeTargetUrl } from "./url-safety";

describe("target URL validation", () => {
  it("accepts public http(s) URLs", () => {
    expect(() => assertSafeTargetUrl("https://example.com/login")).not.toThrow();
    expect(() => assertSafeTargetUrl("http://example.com")).not.toThrow();
  });

  it("rejects non-http protocols", () => {
    expect(() => assertSafeTargetUrl("file:///etc/passwd")).toThrow(/http\/https/);
    expect(() => assertSafeTargetUrl("javascript:alert(1)")).toThrow(/http\/https/);
  });

  it("rejects invalid URLs", () => {
    expect(() => assertSafeTargetUrl("not a url")).toThrow(/Invalid URL/);
  });

  it("blocks localhost and private ranges by default", () => {
    for (const url of [
      "http://localhost:3000",
      "http://127.0.0.1",
      "http://10.0.0.5",
      "http://192.168.1.10",
      "http://172.16.0.1",
      "http://0.0.0.0",
      "http://printer.local"
    ]) {
      expect(() => assertSafeTargetUrl(url), url).toThrow(/private\/localhost/);
    }
  });

  it("allows private targets when explicitly enabled (test environment)", () => {
    expect(() => assertSafeTargetUrl("http://test-web:3001/login", { allowPrivateTargets: true })).not.toThrow();
  });

  it("allows an explicit host allowlist without opening all private ranges", () => {
    const opts = { allowedHosts: ["test-web"] };
    expect(() => assertSafeTargetUrl("http://test-web:3001/login", opts)).not.toThrow();
    expect(() => assertSafeTargetUrl("http://127.0.0.1", opts)).toThrow();
  });
});
