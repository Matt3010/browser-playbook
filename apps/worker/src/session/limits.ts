/**
 * Whether another browser session may be opened, and why not when it may not.
 *
 * Kept apart from the manager because the manager's create() starts Xvfb, x11vnc and
 * Chromium: the decision has to be testable without any of that.
 *
 * There are two caps. The global one protects the machine — one live Chromium leaves
 * roughly 2 GB free on the Raspberry Pi. The per-user one protects the other people
 * on a shared instance: with only a global cap, one user holding every slot locks
 * everybody else out.
 */
export function checkSessionLimits(
  open: Array<{ userId: string }>,
  userId: string,
  limits: { max: number; maxPerUser: number }
): string | null {
  if (open.length >= limits.max) {
    return `Maximum number of concurrent browser sessions reached (${limits.max})`;
  }

  // Zero means "no separate per-user cap", which is the default: on a single-user
  // instance a cap below the global one would make the owner's own scheduled run fail
  // while they are recording, because an execution holds a session of its own.
  if (limits.maxPerUser > 0) {
    const mine = open.filter((session) => session.userId === userId).length;
    if (mine >= limits.maxPerUser) {
      return `Maximum number of concurrent browser sessions per user reached (${limits.maxPerUser})`;
    }
  }

  return null;
}
