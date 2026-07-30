import { cp, mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type { Cookie } from "playwright";

/**
 * Where a browser profile lives, and who is allowed to open it.
 *
 * A run used to start from a browser that had never been anywhere: a fresh
 * temporary directory, deleted at the end. That is the visitor a site asks to log
 * in every single time, and the one an anti-bot check challenges first. A
 * workflow now has a browser of its own, kept between runs, so a login done by
 * hand while recording is still there at three in the morning.
 *
 * Two things this file exists to get right, both pure so they can be argued with
 * in a unit test rather than discovered on the device:
 *
 *  - **A profile belongs to one user.** The path carries the owner, so two users
 *    cannot land in the same directory even if a workflow id were guessed.
 *  - **One profile, one browser.** Chromium keeps a lock file in the profile and
 *    a second instance on the same directory misbehaves, so a recording and a run
 *    of the same workflow must not open it at once. The second one is refused
 *    with a sentence that says who is holding it, rather than failing later
 *    somewhere in the browser.
 */

/** Only what a directory name may hold, so a path can never be escaped. */
const SAFE_SEGMENT = /^[a-zA-Z0-9_-]+$/;

export function isSafeProfileSegment(value: string): boolean {
  return SAFE_SEGMENT.test(value);
}

/**
 * The directory holding this workflow's browser, or null when the session has no
 * workflow (an ad-hoc session gets a throwaway profile, as every session used to).
 *
 * Ids come from the database and are uuids, but this is the one place where a
 * value from outside becomes a filesystem path, so the shape is checked instead
 * of assumed: anything else means "no persistent profile" rather than a path
 * pointing who knows where.
 */
export function profilePathFor(
  root: string,
  userId: string,
  workflowId: string | null | undefined
): string | null {
  if (!workflowId) return null;
  if (!isSafeProfileSegment(userId) || !isSafeProfileSegment(workflowId)) return null;
  return path.join(root, userId, workflowId);
}

export class ProfileInUseError extends Error {}

/**
 * Which profiles are open right now.
 *
 * The worker is one process, so a set in memory is the whole truth — and it is
 * the right truth: the lock must not survive a crash, or a workflow whose worker
 * was killed mid-run could never be opened again.
 */
export class ProfileLocks {
  private readonly held = new Map<string, string>();

  /** Takes the profile for `sessionId`, or explains who has it. */
  acquire(profileDir: string, sessionId: string): void {
    const holder = this.held.get(profileDir);
    if (holder && holder !== sessionId) {
      throw new ProfileInUseError(
        `The browser of this workflow is already open in session ${holder}. ` +
          `Close it, or wait for the run using it to finish.`
      );
    }
    this.held.set(profileDir, sessionId);
  }

  release(profileDir: string, sessionId: string): void {
    if (this.held.get(profileDir) === sessionId) this.held.delete(profileDir);
  }

  holderOf(profileDir: string): string | null {
    return this.held.get(profileDir) ?? null;
  }
}

/**
 * Parts of a profile that must not be copied.
 *
 * When the browser of a workflow is already open — the normal case of pressing
 * "Esegui adesso" straight after recording — the run takes a copy instead of
 * fighting over the directory. Two kinds of thing are left behind:
 *
 *  - **the singleton files**, which are how Chromium claims a profile. Copying
 *    them hands the copy a claim on a directory it does not own, and they are
 *    sockets and symlinks rather than files anyway.
 *  - **the caches**, which are the bulk of a profile and mean nothing to a run.
 *    On a device whose storage is an SD card, copying them is the difference
 *    between a second and a minute.
 *
 * What is kept is what the run needs: cookies, local storage, and the
 * preferences that make the browser look like the one the person used.
 */
const TRANSIENT_PROFILE_ENTRIES = [
  "SingletonLock",
  "SingletonCookie",
  "SingletonSocket",
  "lockfile",
  "Cache",
  "Code Cache",
  "GPUCache",
  "GrShaderCache",
  "ShaderCache",
  "DawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "component_crx_cache",
  "extensions_crx_cache",
  "CacheStorage",
  "Crashpad"
];

/**
 * Where Chromium keeps the cookies on disk.
 *
 * Left behind whenever the browser holding the profile can hand over its cookies
 * itself: what is in the file is then not merely redundant but wrong. It is
 * behind — the store is committed lazily — and it can hold a cookie the live
 * browser has since deleted, which the copy would bring back to life.
 */
const COOKIE_STORE_ENTRIES = ["Cookies", "Cookies-journal"];

/** True when this entry of a profile is worth copying for a run. */
export function isCopyableProfileEntry(
  relativePath: string,
  options: { withoutCookies?: boolean } = {}
): boolean {
  const parts = relativePath.split(/[\\/]/);
  if (parts.some((part) => TRANSIENT_PROFILE_ENTRIES.includes(part))) return false;
  if (options.withoutCookies && parts.some((part) => COOKIE_STORE_ENTRIES.includes(part))) {
    return false;
  }
  return true;
}

/**
 * A throwaway copy of a profile, for a session that must not open the original.
 *
 * What is copied is what makes the browser the same visitor — local storage,
 * preferences, and the cookies unless they are being taken from the live browser
 * instead — and not the caches or the files Chromium uses to claim a directory
 * (see above). The copy lives in the temporary directory and is deleted with the
 * session, so nothing written during the run leaks back into the profile whose
 * owner is still using it.
 */
export async function copyProfileForReading(
  profileDir: string,
  sessionId: string,
  options: { withoutCookies?: boolean } = {}
): Promise<string> {
  const target = await mkdtemp(path.join(tmpdir(), `profile-copy-${sessionId}-`));
  await cp(profileDir, target, {
    recursive: true,
    force: true,
    // A socket or a dangling symlink would throw; both are among the things this
    // deliberately leaves behind anyway.
    filter: (source) => {
      const relative = path.relative(profileDir, source);
      return relative === "" || isCopyableProfileEntry(relative, options);
    }
  });
  return target;
}

/**
 * The state a session takes when the browser it wants is already open.
 *
 * `profileDir` is a throwaway copy, or null when there was nothing to copy;
 * `cookies` are installed before the first navigation.
 */
export interface BorrowedProfile {
  profileDir: string | null;
  cookies: Cookie[];
}

/**
 * Borrows the state of a workflow's browser for a second session.
 *
 * Recording and then pressing "Esegui adesso" without closing is the normal
 * flow, and Chromium will not open one profile twice — so the run has to get the
 * state some other way. It used to copy the directory, which asks a live
 * browser's *disk* a question only the browser can answer: Chromium commits its
 * cookie store lazily, tens of seconds after the login, so the copy taken moments
 * after recording was of a profile that had never logged in. A cookie with no
 * expiry never reaches the disk at all.
 *
 * So the cookies are asked of the browser that holds them, which knows what it
 * has, and the files supply the rest — localStorage, preferences, the things that
 * make the copy the same visitor. Two failures are survivable and both are
 * survived: a holder that cannot answer leaves the disk as the only source, and a
 * copy that cannot be taken still lets the cookies through, because the cookies
 * are the login and the rest is comfort.
 */
export async function borrowProfileForSession(input: {
  profileDir: string;
  sessionId: string;
  /** Asks the browser holding the profile for its cookies; null when it cannot say. */
  liveCookies: () => Promise<Cookie[] | null>;
  onProblem?: (err: unknown, what: string) => void;
}): Promise<BorrowedProfile> {
  let cookies: Cookie[] | null = null;
  try {
    cookies = await input.liveCookies();
  } catch (err) {
    input.onProblem?.(err, "Could not read the cookies of the browser holding this profile");
  }

  try {
    const copied = await copyProfileForReading(input.profileDir, input.sessionId, {
      withoutCookies: cookies !== null
    });
    return { profileDir: copied, cookies: cookies ?? [] };
  } catch (err) {
    input.onProblem?.(err, "Could not copy the workflow's browser profile");
    return { profileDir: null, cookies: cookies ?? [] };
  }
}
