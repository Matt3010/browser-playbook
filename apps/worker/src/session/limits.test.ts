import { describe, expect, it } from "vitest";
import { checkSessionLimits } from "./limits";

const open = (...userIds: string[]) => userIds.map((userId) => ({ userId }));

describe("who may open another browser session", () => {
  it("allows a session while there is room", () => {
    expect(checkSessionLimits(open("alice"), "alice", { max: 2, maxPerUser: 0 })).toBeNull();
  });

  it("refuses when every slot is taken", () => {
    const refusal = checkSessionLimits(open("alice", "bob"), "carol", { max: 2, maxPerUser: 0 });
    expect(refusal).toMatch(/2/);
  });

  it("refuses a user who already holds their share", () => {
    // The cap used to be global only, so one user could take every slot and lock
    // everybody else out of an instance they share.
    const refusal = checkSessionLimits(open("alice"), "alice", { max: 4, maxPerUser: 1 });
    expect(refusal).toMatch(/per user|a testa|1/i);
  });

  it("does not count anybody else's sessions against a user", () => {
    expect(checkSessionLimits(open("bob", "carol"), "alice", { max: 4, maxPerUser: 1 })).toBeNull();
  });

  it("treats a per-user cap of zero as no separate limit", () => {
    // The default on a single-user instance: a cap below the global one would make
    // the owner's own scheduled run fail while they are recording, since an execution
    // holds a session of its own.
    expect(checkSessionLimits(open("alice", "alice"), "alice", { max: 4, maxPerUser: 0 })).toBeNull();
  });

  it("never lets a per-user cap exceed the global one", () => {
    const refusal = checkSessionLimits(open("alice", "bob"), "alice", { max: 2, maxPerUser: 5 });
    expect(refusal, "the global cap still applies").toMatch(/2/);
  });
});
