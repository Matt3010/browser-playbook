import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  borrowProfileForSession,
  isCopyableProfileEntry,
  isSafeProfileSegment,
  profilePathFor,
  ProfileInUseError,
  ProfileLocks
} from "./profile";

describe("profilePathFor", () => {
  const root = path.join("/data", "profiles");

  it("gives a workflow a directory of its own, under its owner", () => {
    expect(profilePathFor(root, "user-1", "workflow-2")).toBe(
      path.join(root, "user-1", "workflow-2")
    );
  });

  it("keeps two users apart even when they name the same workflow", () => {
    const first = profilePathFor(root, "user-1", "shared");
    const second = profilePathFor(root, "user-2", "shared");
    expect(first).not.toBe(second);
  });

  it("has no profile for a session that names no workflow", () => {
    // An ad-hoc session gets a throwaway browser, as every session used to.
    expect(profilePathFor(root, "user-1", null)).toBeNull();
    expect(profilePathFor(root, "user-1", undefined)).toBeNull();
    expect(profilePathFor(root, "user-1", "")).toBeNull();
  });

  it("refuses anything that could leave the root", () => {
    // This is the one place an id from outside becomes a path. `startsWith(root)`
    // is not enough on its own, so the shape is checked instead of the result.
    for (const bad of ["..", "../evil", "a/b", "a\\b", "with space", ".", "a.b"]) {
      expect(profilePathFor(root, "user-1", bad), bad).toBeNull();
      expect(profilePathFor(root, bad, "workflow-1"), bad).toBeNull();
    }
  });

  it("accepts what a uuid looks like, and nothing looser", () => {
    expect(isSafeProfileSegment("9a599318-a904-4f63-a78e-ec0bbce0cf50")).toBe(true);
    expect(isSafeProfileSegment("../9a599318")).toBe(false);
  });
});

describe("ProfileLocks", () => {
  it("lets the same session take its profile twice", () => {
    const locks = new ProfileLocks();
    locks.acquire("/p/one", "session-a");
    expect(() => locks.acquire("/p/one", "session-a")).not.toThrow();
  });

  it("refuses a second session on one profile, and says who has it", () => {
    // Chromium keeps a lock file inside the profile: a second browser on the same
    // directory misbehaves, so a recording and a run of one workflow cannot both
    // open it. Refused here, with a sentence, rather than failing in the browser.
    const locks = new ProfileLocks();
    locks.acquire("/p/one", "session-a");
    expect(() => locks.acquire("/p/one", "session-b")).toThrow(ProfileInUseError);
    expect(() => locks.acquire("/p/one", "session-b")).toThrow(/session-a/);
  });

  it("frees the profile when its session lets go", () => {
    const locks = new ProfileLocks();
    locks.acquire("/p/one", "session-a");
    locks.release("/p/one", "session-a");
    expect(locks.holderOf("/p/one")).toBeNull();
    expect(() => locks.acquire("/p/one", "session-b")).not.toThrow();
  });

  it("ignores a release from a session that is not the holder", () => {
    // Otherwise a session closing late would unlock a profile somebody else has
    // just taken, and two browsers would open on it.
    const locks = new ProfileLocks();
    locks.acquire("/p/one", "session-a");
    locks.release("/p/one", "session-b");
    expect(locks.holderOf("/p/one")).toBe("session-a");
  });

  it("keeps different profiles independent", () => {
    const locks = new ProfileLocks();
    locks.acquire("/p/one", "session-a");
    expect(() => locks.acquire("/p/two", "session-b")).not.toThrow();
  });
});

describe("isCopyableProfileEntry", () => {
  it("keeps what a run needs to look like the browser that recorded", () => {
    for (const kept of [
      "Cookies",
      "Default/Cookies",
      "Default/Local Storage/leveldb/000003.log",
      "Preferences",
      "Local State"
    ]) {
      expect(isCopyableProfileEntry(kept), kept).toBe(true);
    }
  });

  it("leaves behind the claim Chromium keeps on a profile", () => {
    // Copying these hands the copy a claim on a directory it does not own — and
    // they are sockets and symlinks, which do not copy as files anyway.
    for (const skipped of ["SingletonLock", "SingletonSocket", "SingletonCookie", "lockfile"]) {
      expect(isCopyableProfileEntry(skipped), skipped).toBe(false);
    }
  });

  it("leaves behind the caches, which are the bulk and mean nothing to a run", () => {
    for (const skipped of [
      "Default/Cache/data_0",
      "Default/Code Cache/js/index",
      "GPUCache/index",
      "Default/Service Worker/CacheStorage/abc/def",
      "Crashpad/settings.dat"
    ]) {
      expect(isCopyableProfileEntry(skipped), skipped).toBe(false);
    }
  });

  it("reads a Windows path the same way as a POSIX one", () => {
    expect(isCopyableProfileEntry("Default\\Cache\\data_0")).toBe(false);
    expect(isCopyableProfileEntry("Default\\Cookies")).toBe(true);
  });

  it("leaves the cookie store behind when a live browser will supply the cookies", () => {
    // What is on disk is then not just redundant but wrong: a cookie deleted in
    // the live browser is still in its file, and would come back in the copy.
    for (const store of ["Cookies", "Default/Cookies", "Default/Cookies-journal"]) {
      expect(isCopyableProfileEntry(store, { withoutCookies: true }), store).toBe(false);
    }
    expect(isCopyableProfileEntry("Preferences", { withoutCookies: true })).toBe(true);
    expect(
      isCopyableProfileEntry("Default/Local Storage/leveldb/000003.log", { withoutCookies: true })
    ).toBe(true);
  });
});

describe("borrowProfileForSession", () => {
  const made: string[] = [];

  afterEach(async () => {
    await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })));
    made.length = 0;
  });

  /** A profile on disk that looks like one Chromium has been using. */
  async function profileOnDisk(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "profile-source-"));
    made.push(dir);
    await mkdir(path.join(dir, "Default"), { recursive: true });
    await writeFile(path.join(dir, "Default", "Cookies"), "stale sqlite bytes");
    await writeFile(path.join(dir, "Preferences"), "{}");
    await writeFile(path.join(dir, "SingletonLock"), "held");
    return dir;
  }

  const cookie = {
    name: "session",
    value: "fresh-from-the-browser",
    domain: "example.test",
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: false,
    sameSite: "Lax" as const
  };

  it("takes the cookies from the browser holding the profile, not from its disk", async () => {
    // Chromium commits its cookie database lazily — tens of seconds after the
    // login — so a copy taken right after recording is of a profile that never
    // logged in. The browser itself knows what it has, so it is asked.
    const source = await profileOnDisk();
    const borrowed = await borrowProfileForSession({
      profileDir: source,
      sessionId: "session-b",
      liveCookies: async () => [cookie]
    });
    made.push(borrowed.profileDir!);

    expect(borrowed.cookies).toEqual([cookie]);
    // The stale file must not be carried over: the live set is the whole truth.
    expect(existsSync(path.join(borrowed.profileDir!, "Default", "Cookies"))).toBe(false);
    // Everything else a copy is for — localStorage, preferences — still comes.
    expect(existsSync(path.join(borrowed.profileDir!, "Preferences"))).toBe(true);
    expect(existsSync(path.join(borrowed.profileDir!, "SingletonLock"))).toBe(false);
  });

  it("writes nothing back into the profile it borrowed from", async () => {
    const source = await profileOnDisk();
    const borrowed = await borrowProfileForSession({
      profileDir: source,
      sessionId: "session-b",
      liveCookies: async () => [cookie]
    });
    made.push(borrowed.profileDir!);

    expect(borrowed.profileDir).not.toBe(source);
    expect(await readdir(source)).toContain("SingletonLock");
  });

  it("falls back to the disk when the holder cannot answer", async () => {
    // A copy of a possibly stale cookie store is a poor answer, and still a far
    // better one than starting from a browser that has never been anywhere.
    const source = await profileOnDisk();
    const borrowed = await borrowProfileForSession({
      profileDir: source,
      sessionId: "session-b",
      liveCookies: async () => null
    });
    made.push(borrowed.profileDir!);

    expect(borrowed.cookies).toEqual([]);
    expect(existsSync(path.join(borrowed.profileDir!, "Default", "Cookies"))).toBe(true);
  });

  it("treats a holder that throws as one that cannot answer", async () => {
    const source = await profileOnDisk();
    const borrowed = await borrowProfileForSession({
      profileDir: source,
      sessionId: "session-b",
      liveCookies: async () => {
        throw new Error("the browser closed while we were asking");
      }
    });
    made.push(borrowed.profileDir!);

    expect(borrowed.cookies).toEqual([]);
    expect(existsSync(path.join(borrowed.profileDir!, "Default", "Cookies"))).toBe(true);
  });

  it("still hands over the cookies when there is nothing to copy", async () => {
    // The cookies are the login. Losing the copy costs preferences and history;
    // losing the cookies costs the run.
    const borrowed = await borrowProfileForSession({
      profileDir: path.join(tmpdir(), "profile-that-is-not-there"),
      sessionId: "session-b",
      liveCookies: async () => [cookie]
    });

    expect(borrowed.profileDir).toBeNull();
    expect(borrowed.cookies).toEqual([cookie]);
  });
});
