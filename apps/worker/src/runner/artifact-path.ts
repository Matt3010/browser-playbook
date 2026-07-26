import path from "path";

/**
 * Builds the path a downloaded file is stored at.
 *
 * The file name comes from the visited site (Content-Disposition or the URL), so
 * it is attacker-controlled: used unchecked it is a path-traversal write
 * primitive inside the worker container. Only the base name is kept, anything
 * that could still climb out is neutralised, and the result is asserted to stay
 * inside the execution's own directory.
 */
export function safeDownloadPath(
  artifactDir: string,
  executionId: string,
  suggestedFilename: string
): string {
  const executionDir = path.resolve(artifactDir, executionId);

  // Strip any directory component the site tried to smuggle in, on both
  // separators: a Linux worker must not trust a Windows-style path either.
  const base = path
    .basename(suggestedFilename.replace(/\\/g, "/"))
    .replace(/[/\\]/g, "")
    .trim();

  // `..`, `.` and empty names must never become the file name.
  const cleaned = base === "" || base === "." || base === ".." ? "file" : base;

  const target = path.resolve(executionDir, `download-${cleaned}`);
  if (target !== path.join(executionDir, `download-${cleaned}`)) {
    throw new Error(`Refusing to store a download outside its execution directory: ${suggestedFilename}`);
  }
  if (!target.startsWith(executionDir + path.sep)) {
    throw new Error(`Refusing to store a download outside its execution directory: ${suggestedFilename}`);
  }
  return target;
}
