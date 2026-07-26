import type { Logger } from "@app/shared";
import type { WorkerConfig } from "../config";
import { SlotAllocator, NoSlotAvailableError } from "./allocator";
import { BrowserSession } from "./session";

export class SessionLimitError extends Error {
  constructor(limit: number) {
    super(`Maximum number of concurrent browser sessions reached (${limit})`);
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
    timeoutMs?: number;
    /** Omit for sessions driven by a running execution: those must not be reaped. */
    idleTimeoutMs?: number | null;
  }): Promise<BrowserSession> {
    if (this.sessions.size >= this.config.maxSessions) {
      throw new SessionLimitError(this.config.maxSessions);
    }

    let slot;
    try {
      slot = this.allocator.allocate();
    } catch (err) {
      if (err instanceof NoSlotAvailableError) throw new SessionLimitError(this.config.maxSessions);
      throw err;
    }

    const session = new BrowserSession({
      sessionId: input.sessionId,
      userId: input.userId,
      startUrl: input.startUrl,
      timeoutMs: input.timeoutMs ?? this.config.sessionTimeoutMs,
      idleTimeoutMs:
        input.idleTimeoutMs === undefined ? this.config.sessionIdleTimeoutMs : input.idleTimeoutMs,
      slot,
      screenWidth: this.config.screenWidth,
      screenHeight: this.config.screenHeight,
      logger: this.log,
      onClosed: (sessionId) => {
        this.sessions.delete(sessionId);
        this.allocator.release(slot);
      }
    });

    this.sessions.set(input.sessionId, session);
    try {
      await session.start();
    } catch (err) {
      this.sessions.delete(input.sessionId);
      this.allocator.release(slot);
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
