import type { Cookie } from "playwright";
import type { Logger } from "@app/shared";
import type { WorkerConfig } from "../config";
import { SlotAllocator, NoSlotAvailableError } from "./allocator";
import {
  borrowProfileForSession,
  profilePathFor,
  ProfileLocks,
  type OriginStorage
} from "./profile";
import { BrowserSession } from "./session";
import { checkSessionLimits } from "./limits";

export class SessionLimitError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} not found`);
  }
}

/** How often abandoned sessions are looked for. */
const REAP_INTERVAL_MS = 15_000;

export class SessionManager {
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly allocator: SlotAllocator;
  /** Which workflow profiles are open right now; see session/profile.ts. */
  private readonly profileLocks = new ProfileLocks();
  private reaper: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: WorkerConfig,
    private readonly log: Logger
  ) {
    this.allocator = new SlotAllocator({
      displayStart: config.displayRangeStart,
      displayEnd: config.displayRangeEnd,
      vncPortStart: config.vncPortRangeStart,
      vncPortEnd: config.vncPortRangeEnd,
      rfbPortStart: config.rfbPortRangeStart
    });
  }

  /**
   * Closes sessions nobody is driving any more. Without this a session whose
   * page was closed would hold its slot until the maximum lifetime expired,
   * blocking new sessions on a host with few slots.
   */
  startReaper(): void {
    if (this.reaper) return;
    this.reaper = setInterval(() => {
      for (const session of [...this.sessions.values()]) {
        if (!session.isIdle()) continue;
        this.log.warn(
          { sessionId: session.sessionId, idleMs: session.idleMs },
          "Closing an abandoned browser session to reclaim its slot"
        );
        void session.close().catch((err) => {
          this.log.error({ err, sessionId: session.sessionId }, "Failed to reap a session");
        });
      }
    }, REAP_INTERVAL_MS);
    this.reaper.unref();
  }

  stopReaper(): void {
    if (this.reaper) {
      clearInterval(this.reaper);
      this.reaper = null;
    }
  }

  list(): BrowserSession[] {
    return [...this.sessions.values()];
  }

  get count(): number {
    return this.sessions.size;
  }

  async create(input: {
    sessionId: string;
    userId: string;
    startUrl: string;
    /**
     * Whose browser to open. A session that names its workflow gets that
     * workflow's kept profile, with whatever the last session left in it; one
     * that names none gets a throwaway, as every session used to.
     */
    workflowId?: string | null;
    timeoutMs?: number;
    /** Omit for sessions driven by a running execution: those must not be reaped. */
    idleTimeoutMs?: number | null;
  }): Promise<BrowserSession> {
    const refusal = checkSessionLimits(
      [...this.sessions.values()].map((session) => ({ userId: session.userId })),
      input.userId,
      { max: this.config.maxSessions, maxPerUser: this.config.maxSessionsPerUser }
    );
    if (refusal) throw new SessionLimitError(refusal);

    let slot;
    try {
      slot = this.allocator.allocate();
    } catch (err) {
      if (err instanceof NoSlotAvailableError) {
        throw new SessionLimitError(
          `Maximum number of concurrent browser sessions reached (${this.config.maxSessions})`
        );
      }
      throw err;
    }

    /*
     * Which browser this session opens.
     *
     * Chromium keeps a claim inside a profile, so the same directory must not be
     * opened twice. But the normal thing a person does is press "Esegui adesso"
     * with the recording browser still on screen, and refusing that would break
     * the very flow the kept profile exists to serve. So the second one borrows:
     * the session state from the browser that holds it — the only thing that knows
     * it, its files being tens of seconds behind — and the rest from a copy of the
     * directory, which it writes nothing back into.
     */
    let profileDir = profilePathFor(this.config.profileDir, input.userId, input.workflowId);
    let ownsProfile = false;
    let seedCookies: Cookie[] | undefined;
    let seedOrigins: OriginStorage[] | undefined;
    if (profileDir) {
      const holder = this.profileLocks.holderOf(profileDir);
      if (holder && holder !== input.sessionId) {
        const borrowed = await borrowProfileForSession({
          profileDir,
          sessionId: input.sessionId,
          liveState: async () => (await this.sessions.get(holder)?.exportState()) ?? null,
          onProblem: (err, what) => this.log.warn({ err, holder }, what)
        });
        profileDir = borrowed.profileDir;
        seedCookies = borrowed.cookies;
        seedOrigins = borrowed.origins;
        this.log.info(
          {
            holder,
            profileDir,
            cookies: borrowed.cookies.length,
            origins: borrowed.origins.length
          },
          "The workflow's browser is already open; this session borrows its state"
        );
      } else {
        this.profileLocks.acquire(profileDir, input.sessionId);
        ownsProfile = true;
      }
    }

    const session = new BrowserSession({
      sessionId: input.sessionId,
      userId: input.userId,
      startUrl: input.startUrl,
      profileDir,
      // A copy is a throwaway: it is deleted with the session, like the profile
      // of a session that belongs to no workflow.
      keepProfile: ownsProfile,
      seedCookies,
      seedOrigins,
      timeoutMs: input.timeoutMs ?? this.config.sessionTimeoutMs,
      idleTimeoutMs:
        input.idleTimeoutMs === undefined ? this.config.sessionIdleTimeoutMs : input.idleTimeoutMs,
      slot,
      screenWidth: this.config.screenWidth,
      screenHeight: this.config.screenHeight,
      logger: this.log,
      urlSafety: {
        allowPrivateTargets: this.config.allowPrivateTargets,
        allowedHosts: this.config.allowedTargetHosts
      },
      onClosed: (sessionId) => {
        this.sessions.delete(sessionId);
        this.allocator.release(slot);
        if (profileDir && ownsProfile) this.profileLocks.release(profileDir, sessionId);
      }
    });

    this.sessions.set(input.sessionId, session);
    try {
      await session.start();
    } catch (err) {
      this.sessions.delete(input.sessionId);
      this.allocator.release(slot);
      if (profileDir && ownsProfile) this.profileLocks.release(profileDir, input.sessionId);
      throw err;
    }
    return session;
  }

  get(sessionId: string): BrowserSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new SessionNotFoundError(sessionId);
    return session;
  }

  find(sessionId: string): BrowserSession | undefined {
    return this.sessions.get(sessionId);
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new SessionNotFoundError(sessionId);
    await session.close();
  }

  async closeAll(): Promise<void> {
    this.stopReaper();
    const sessions = [...this.sessions.values()];
    await Promise.allSettled(sessions.map((s) => s.close()));
    this.sessions.clear();
  }
}
