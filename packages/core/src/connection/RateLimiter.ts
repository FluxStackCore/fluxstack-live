// @fluxstack/live - Per-connection rate limiter
//
// Token bucket algorithm to prevent WebSocket message flooding.

import { DEFAULT_RATE_LIMIT_MAX_TOKENS, DEFAULT_RATE_LIMIT_REFILL_RATE } from '../protocol/constants'

export class ConnectionRateLimiter {
  private tokens: number
  private lastRefill: number
  private readonly maxTokens: number
  private readonly refillRate: number // tokens per second

  constructor(maxTokens = DEFAULT_RATE_LIMIT_MAX_TOKENS, refillRate = DEFAULT_RATE_LIMIT_REFILL_RATE) {
    this.maxTokens = maxTokens
    this.tokens = maxTokens
    this.refillRate = refillRate
    this.lastRefill = Date.now()
  }

  tryConsume(count = 1): boolean {
    this.refill()
    if (this.tokens >= count) {
      this.tokens -= count
      return true
    }
    return false
  }

  private refill(): void {
    const now = Date.now()
    const elapsed = (now - this.lastRefill) / 1000
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate)
    this.lastRefill = now
  }
}

/**
 * Manages rate limiters for all connections.
 */
export class RateLimiterRegistry {
  private limiters = new Map<string, ConnectionRateLimiter>()
  private maxTokens: number
  private refillRate: number

  constructor(maxTokens = DEFAULT_RATE_LIMIT_MAX_TOKENS, refillRate = DEFAULT_RATE_LIMIT_REFILL_RATE) {
    this.maxTokens = maxTokens
    this.refillRate = refillRate
  }

  /**
   * Get or create a rate limiter for a connection.
   */
  get(connectionId: string): ConnectionRateLimiter {
    let limiter = this.limiters.get(connectionId)
    if (!limiter) {
      limiter = new ConnectionRateLimiter(this.maxTokens, this.refillRate)
      this.limiters.set(connectionId, limiter)
    }
    return limiter
  }

  /**
   * Remove a rate limiter for a disconnected connection.
   */
  remove(connectionId: string): void {
    this.limiters.delete(connectionId)
  }
}
