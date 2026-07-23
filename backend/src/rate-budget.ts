/**
 * Sliding-window limiter for outbound TfL calls (the P2 slice of the
 * rate-budget lanes described in ARCHITECTURE.md). Callers must check
 * `tryConsume()` before every upstream request.
 */
export class RateBudget {
  private timestamps: readonly number[] = [];

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Consumes one unit if the window has room; returns false when exhausted. */
  tryConsume(now: number = Date.now()): boolean {
    const inWindow = this.timestamps.filter((t) => now - t < this.windowMs);
    if (inWindow.length >= this.limit) {
      this.timestamps = inWindow;
      return false;
    }
    this.timestamps = [...inWindow, now];
    return true;
  }
}
