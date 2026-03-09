/**
 * Simple sliding-window rate limiter for outbound message sends.
 * Default: 5 messages per 3 seconds per target.
 */
export class RateLimiter {
  private buckets = new Map<string, number[]>();
  private readonly maxTokens: number;
  private readonly windowMs: number;

  constructor(maxTokens = 5, windowMs = 3000) {
    this.maxTokens = maxTokens;
    this.windowMs = windowMs;
  }

  /**
   * Wait until a send slot is available for the given target key.
   */
  async acquire(targetKey: string): Promise<void> {
    const now = Date.now();
    let timestamps = this.buckets.get(targetKey) ?? [];
    // Prune old entries
    timestamps = timestamps.filter((t) => now - t < this.windowMs);

    if (timestamps.length >= this.maxTokens) {
      const oldest = timestamps[0];
      const waitMs = this.windowMs - (now - oldest) + 10; // +10ms buffer
      await new Promise((r) => setTimeout(r, waitMs));
      return this.acquire(targetKey); // retry after wait
    }

    timestamps.push(now);
    this.buckets.set(targetKey, timestamps);
  }

  /** Clean up stale entries. Call periodically. */
  cleanup(): void {
    const now = Date.now();
    for (const [key, timestamps] of this.buckets) {
      const active = timestamps.filter((t) => now - t < this.windowMs);
      if (active.length === 0) this.buckets.delete(key);
      else this.buckets.set(key, active);
    }
  }
}
