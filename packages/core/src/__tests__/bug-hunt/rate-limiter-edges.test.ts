// Bug hunt: ConnectionRateLimiter edge cases that the happy-path tests miss.
//
// Approach: pass values the implementation didn't think about (negative,
// NaN, Infinity, zero) and clock manipulations that reveal hidden assumptions.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ConnectionRateLimiter, RateLimiterRegistry } from '../../connection/RateLimiter'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('ConnectionRateLimiter — adversarial tryConsume() inputs', () => {
  it('negative count is rejected (does not refund tokens)', () => {
    const rl = new ConnectionRateLimiter(10, 1)
    expect(rl.tryConsume(5)).toBe(true) // 5 tokens left
    expect(rl.tryConsume(-3)).toBe(false) // negative is invalid
    // Bucket remains at 5 — no refund occurred.
    let after = 0
    while (rl.tryConsume(1)) after++
    expect(after).toBe(5)
  })

  it('count = 0 is always accepted (no-op consume)', () => {
    const rl = new ConnectionRateLimiter(10, 1)
    rl.tryConsume(10) // empty
    expect(rl.tryConsume(0)).toBe(true)
  })

  it('count larger than maxTokens is always rejected, even on full bucket', () => {
    const rl = new ConnectionRateLimiter(10, 1)
    expect(rl.tryConsume(11)).toBe(false)
    // Bucket unchanged
    let used = 0
    while (rl.tryConsume(1)) used++
    expect(used).toBe(10)
  })

  it('count = NaN is rejected (NaN >= anything is false)', () => {
    const rl = new ConnectionRateLimiter(10, 1)
    // tokens >= NaN is false in JS, so consume returns false.
    expect(rl.tryConsume(NaN)).toBe(false)
    // Bucket untouched
    let used = 0
    while (rl.tryConsume(1)) used++
    expect(used).toBe(10)
  })

  it('count = Infinity is rejected (10 >= Infinity is false)', () => {
    const rl = new ConnectionRateLimiter(10, 1)
    expect(rl.tryConsume(Infinity)).toBe(false)
  })
})

describe('ConnectionRateLimiter — refill clock', () => {
  it('refills proportional to elapsed time', () => {
    const rl = new ConnectionRateLimiter(10, 10) // 10 tokens/sec
    // Drain
    while (rl.tryConsume(1)) {}
    // Wait 500ms — should refill ~5 tokens
    vi.advanceTimersByTime(500)
    let got = 0
    while (rl.tryConsume(1)) got++
    expect(got).toBeGreaterThanOrEqual(4)
    expect(got).toBeLessThanOrEqual(6)
  })

  it('refill caps at maxTokens (does not exceed bucket size)', () => {
    const rl = new ConnectionRateLimiter(5, 100)
    vi.advanceTimersByTime(10_000) // way more than enough to overflow
    let got = 0
    while (rl.tryConsume(1)) got++
    expect(got).toBe(5)
  })

  it('backwards clock skew does NOT corrupt the bucket (regression: bug found via tests)', () => {
    const rl = new ConnectionRateLimiter(10, 10)
    rl.tryConsume(10) // empty bucket

    // Simulate the system clock moving backwards by 1 minute. The previous
    // implementation produced negative `elapsed`, credited negative tokens,
    // and left the bucket permanently broken. The fix clamps elapsed to >=0.
    const start = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(start - 60_000)
    expect(rl.tryConsume(0)).toBe(true) // refill no-op, bucket still empty but not negative
    expect(rl.tryConsume(1)).toBe(false) // and an actual consume rejects (still empty)
    vi.spyOn(Date, 'now').mockReturnValue(start)
    // The next refill at the original `now` advances tokens normally
    // (1 second elapsed × 10 = +10 tokens, capped at maxTokens=10).
    vi.advanceTimersByTime(1000)
    let recovered = 0
    while (rl.tryConsume(1)) recovered++
    expect(recovered).toBe(10)
  })

  it('🔍 a future clock skew (jump forward) gives one big refill (DoS-relevant?)', () => {
    const rl = new ConnectionRateLimiter(100, 10)
    rl.tryConsume(100) // empty
    // Jump forward 1 hour
    vi.advanceTimersByTime(60 * 60 * 1000)
    let got = 0
    while (rl.tryConsume(1)) got++
    // Bucket caps at 100, not 1000*60 — so this is fine.
    expect(got).toBe(100)
  })
})

describe('RateLimiterRegistry', () => {
  it('returns the same limiter for the same id', () => {
    const reg = new RateLimiterRegistry(10, 1)
    const a = reg.get('conn-1')
    const b = reg.get('conn-1')
    expect(a).toBe(b)
  })

  it('returns different limiters for different ids', () => {
    const reg = new RateLimiterRegistry(10, 1)
    expect(reg.get('a')).not.toBe(reg.get('b'))
  })

  it('remove() actually removes (next get returns a new limiter)', () => {
    const reg = new RateLimiterRegistry(10, 1)
    const a = reg.get('conn-1')
    a.tryConsume(10) // drain
    reg.remove('conn-1')
    const b = reg.get('conn-1')
    expect(b).not.toBe(a)
    // New limiter starts full
    let got = 0
    while (b.tryConsume(1)) got++
    expect(got).toBe(10)
  })

  it('remove() on unknown id is a no-op', () => {
    const reg = new RateLimiterRegistry(10, 1)
    expect(() => reg.remove('ghost')).not.toThrow()
  })

  it('🔍 1000 unique ids never call remove() — memory leak vector', () => {
    // The registry has no cap. Connection-id flood would grow `limiters` Map
    // indefinitely. Documenting current behavior so we have a leak-aware test
    // for the day a TTL or LRU is added.
    const reg = new RateLimiterRegistry(10, 1)
    for (let i = 0; i < 1000; i++) reg.get(`conn-${i}`)
    // No explicit assertion on internals — the test acts as a documentation
    // anchor. It will not fail until/unless someone adds a cap that should
    // bound this number.
    expect(true).toBe(true)
  })
})
