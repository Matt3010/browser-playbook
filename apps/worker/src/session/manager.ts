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

export class SessionManager {
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly allocator: SlotAllocator;

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

  get count(): number {
    return this.sessions.size;
  }

  async create(input: {
    sessionId: string;
    userId: string;
    startUrl: string;
    timeoutMs?: number;
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
    const sessions = [...this.sessions.values()];
    await Promise.allSettled(sessions.map((s) => s.close()));
    this.sessions.clear();
  }
}
