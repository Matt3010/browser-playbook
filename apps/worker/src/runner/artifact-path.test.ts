import { describe, expect, it } from "vitest";
import path from "path";
import { safeDownloadPath } from "./artifact-path";

const DIR = "/data/artifacts";
const EXEC = "11111111-2222-4333-8444-555555555555";
const executionDir = path.resolve(DIR, EXEC);

describe("safeDownloadPath", () => {
  it("stores a normal download inside the execution directory", () => {
    const target = safeDownloadPath(DIR, EXEC, "report.pdf");
    expect(target).toBe(path.join(executionDir, "download-report.pdf"));
  });

  it("neutralises a traversing file name from the visited site", () => {
    // The site controls Content-Disposition; without sanitising, enough `..`
    // segments escape the artifact directory entirely and write anywhere.
    for (const hostile of [
      "../../../../etc/passwd",
      "../../evil.txt",
      "..%2F..%2Fevil.txt",
      "/etc/passwd",
      "..\\..\\windows\\system32\\evil.dll",
      "sub/dir/file.txt"
    ]) {
      const target = safeDownloadPath(DIR, EXEC, hostile);
      expect(target.startsWith(executionDir + path.sep), hostile).toBe(true);
      expect(path.dirname(target), hostile).toBe(executionDir);
    }
  });

  it("keeps the visible file name, not the directories around it", () => {
    expect(safeDownloadPath(DIR, EXEC, "../../../etc/passwd")).toBe(
      path.join(executionDir, "download-passwd")
    );
    expect(safeDownloadPath(DIR, EXEC, "sub/dir/report.pdf")).toBe(
      path.join(executionDir, "download-report.pdf")
    );
  });

  it("falls back to a safe name for degenerate inputs", () => {
    for (const degenerate of ["", "   ", ".", "..", "/", "\\"]) {
      const target = safeDownloadPath(DIR, EXEC, degenerate);
      expect(path.dirname(target), JSON.stringify(degenerate)).toBe(executionDir);
      expect(path.basename(target)).not.toBe("download-");
    }
  });

  it("keeps unicode and spaces in the name", () => {
    expect(safeDownloadPath(DIR, EXEC, "fattura giugno €.pdf")).toBe(
      path.join(executionDir, "download-fattura giugno €.pdf")
    );
  });

  it("keeps each execution's downloads separate", () => {
    const other = "99999999-2222-4333-8444-555555555555";
    expect(safeDownloadPath(DIR, EXEC, "a.txt")).not.toBe(safeDownloadPath(DIR, other, "a.txt"));
  });
});
