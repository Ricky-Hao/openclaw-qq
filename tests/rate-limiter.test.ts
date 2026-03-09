import { describe, it, expect, vi, beforeEach } from "vitest";
import { RateLimiter } from "../src/rate-limiter.js";

describe("RateLimiter", () => {
  it("should allow requests within the limit", async () => {
    const limiter = new RateLimiter(3, 100);
    const start = Date.now();
    await limiter.acquire("a");
    await limiter.acquire("a");
    await limiter.acquire("a");
    // All 3 should pass immediately
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("should throttle when limit is exceeded", async () => {
    const limiter = new RateLimiter(2, 200);
    await limiter.acquire("a");
    await limiter.acquire("a");
    const start = Date.now();
    await limiter.acquire("a"); // Should wait ~200ms
    expect(Date.now() - start).toBeGreaterThanOrEqual(150);
  });

  it("should track targets independently", async () => {
    const limiter = new RateLimiter(1, 200);
    await limiter.acquire("a");
    const start = Date.now();
    await limiter.acquire("b"); // Different target, should pass immediately
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("cleanup should remove stale entries", async () => {
    const limiter = new RateLimiter(5, 50);
    await limiter.acquire("a");
    await limiter.acquire("b");
    // Wait for entries to expire
    await new Promise((r) => setTimeout(r, 60));
    limiter.cleanup();
    // Internal buckets should be empty — verify by acquiring maxTokens without blocking
    const start = Date.now();
    for (let i = 0; i < 5; i++) await limiter.acquire("a");
    expect(Date.now() - start).toBeLessThan(50);
  });
});
