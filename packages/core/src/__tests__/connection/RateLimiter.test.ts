// Tests for ConnectionRateLimiter + RateLimiterRegistry
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ConnectionRateLimiter, RateLimiterRegistry } from '../../connection/RateLimiter'

describe('ConnectionRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts with full tokens', () => {
    const limiter = new ConnectionRateLimiter(10, 5)
    // Should be able to consume 10 tokens immediately
    for (let i = 0; i < 10; i++) {
      expect(limiter.tryConsume()).toBe(true)
    }
    // 11th should fail
    expect(limiter.tryConsume()).toBe(false)
  })

  it('refills tokens over time', () => {
    const limiter = new ConnectionRateLimiter(10, 10) // 10 tokens/sec
    // Drain all tokens
    for (let i = 0; i < 10; i++) {
      limiter.tryConsume()
    }
    expect(limiter.tryConsume()).toBe(false)

    // Wait 500ms — should refill 5 tokens
    vi.advanceTimersByTime(500)
    for (let i = 0; i < 5; i++) {
      expect(limiter.tryConsume()).toBe(true)
    }
    expect(limiter.tryConsume()).toBe(false)
  })

  it('does not exceed maxTokens on refill', () => {
    const limiter = new ConnectionRateLimiter(10, 100) // Very fast refill
    // Wait a long time
    vi.advanceTimersByTime(10_000)

    // Should still only have 10 tokens max
    for (let i = 0; i < 10; i++) {
      expect(limiter.tryConsume()).toBe(true)
    }
    expect(limiter.tryConsume()).toBe(false)
  })

  it('supports consuming multiple tokens at once', () => {
    const limiter = new ConnectionRateLimiter(10, 5)
    expect(limiter.tryConsume(5)).toBe(true)
    expect(limiter.tryConsume(5)).toBe(true)
    expect(limiter.tryConsume(1)).toBe(false)
  })

  it('rejects when not enough tokens for requested count', () => {
    const limiter = new ConnectionRateLimiter(5, 5)
    expect(limiter.tryConsume(6)).toBe(false) // More than maxTokens
  })

  it('uses default values from constants', () => {
    const limiter = new ConnectionRateLimiter()
    // Should not throw, defaults from protocol/constants
    expect(limiter.tryConsume()).toBe(true)
  })
})

describe('RateLimiterRegistry', () => {
  it('creates new limiter on first get', () => {
    const registry = new RateLimiterRegistry()
    const limiter = registry.get('conn-1')
    expect(limiter).toBeInstanceOf(ConnectionRateLimiter)
  })

  it('returns same limiter on subsequent gets', () => {
    const registry = new RateLimiterRegistry()
    const limiter1 = registry.get('conn-1')
    const limiter2 = registry.get('conn-1')
    expect(limiter1).toBe(limiter2)
  })

  it('creates separate limiters per connection', () => {
    const registry = new RateLimiterRegistry()
    const limiter1 = registry.get('conn-1')
    const limiter2 = registry.get('conn-2')
    expect(limiter1).not.toBe(limiter2)
  })

  it('removes limiter on cleanup', () => {
    const registry = new RateLimiterRegistry()
    const limiter1 = registry.get('conn-1')
    registry.remove('conn-1')

    // Should create a new one
    const limiter2 = registry.get('conn-1')
    expect(limiter2).not.toBe(limiter1)
  })

  it('uses custom maxTokens and refillRate', () => {
    const registry = new RateLimiterRegistry(5, 1)
    const limiter = registry.get('conn-1')

    // Should only have 5 tokens
    for (let i = 0; i < 5; i++) {
      expect(limiter.tryConsume()).toBe(true)
    }
    expect(limiter.tryConsume()).toBe(false)
  })
})
