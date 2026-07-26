/**
 * Hands out a display number plus the two ports a session needs, and guarantees
 * that no two live sessions ever share any of them.
 */
export interface SessionSlot {
  display: number;
  /** Loopback-only RFB port served by x11vnc. */
  rfbPort: number;
  /** Container-network port served by websockify, proxied by the API. */
  vncPort: number;
}

export class NoSlotAvailableError extends Error {
  constructor() {
    super("No free browser session slot available");
  }
}

export interface AllocatorRanges {
  displayStart: number;
  displayEnd: number;
  vncPortStart: number;
  vncPortEnd: number;
  rfbPortStart: number;
}

export class SlotAllocator {
  private readonly taken = new Map<number, SessionSlot>();

  constructor(private readonly ranges: AllocatorRanges) {}

  allocate(): SessionSlot {
    for (let display = this.ranges.displayStart; display <= this.ranges.displayEnd; display += 1) {
      if (this.taken.has(display)) continue;
      const offset = display - this.ranges.displayStart;
      const vncPort = this.ranges.vncPortStart + offset;
      if (vncPort > this.ranges.vncPortEnd) break;
      const slot: SessionSlot = {
        display,
        rfbPort: this.ranges.rfbPortStart + offset,
        vncPort
      };
      this.taken.set(display, slot);
      return slot;
    }
    throw new NoSlotAvailableError();
  }

  release(slot: SessionSlot): void {
    this.taken.delete(slot.display);
  }

  get size(): number {
    return this.taken.size;
  }
}
