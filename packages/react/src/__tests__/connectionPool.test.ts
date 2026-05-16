// Tests for the connection pool that backs LiveComponentsProvider (#34).
// We use a fake LiveConnection — the pool's contract is "give me back the
// same instance for the same key, and dispose only after a grace window".

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  acquire,
  release,
  poolKey,
  _resetPool,
  _poolSize,
  _refcount,
} from '../connectionPool'

class FakeConn {
  static instances = 0
  id = ++FakeConn.instances
  disconnected = false
  disconnect() { this.disconnected = true }
}

beforeEach(() => {
  _resetPool()
  FakeConn.instances = 0
  vi.useFakeTimers()
})

describe('connection pool (#34)', () => {
  it('returns the same connection for the same key on repeat acquire', () => {
    const key = poolKey({ url: 'ws://x/ws' })
    const a = acquire(key, () => new FakeConn() as any)
    const b = acquire(key, () => new FakeConn() as any)
    expect(a).toBe(b)
    expect(_refcount(key)).toBe(2)
  })

  it('different keys produce different connections', () => {
    const a = acquire(poolKey({ url: 'ws://a/ws' }), () => new FakeConn() as any)
    const b = acquire(poolKey({ url: 'ws://b/ws' }), () => new FakeConn() as any)
    expect(a).not.toBe(b)
    expect(_poolSize()).toBe(2)
  })

  it('different auth produces a different key', () => {
    const k1 = poolKey({ url: 'ws://x', auth: { type: 'session', token: 'a' } as any })
    const k2 = poolKey({ url: 'ws://x', auth: { type: 'session', token: 'b' } as any })
    expect(k1).not.toBe(k2)
  })

  it('does NOT disconnect when refcount drops to zero before grace window elapses (StrictMode remount)', () => {
    const key = poolKey({ url: 'ws://x/ws' })
    const c1 = acquire(key, () => new FakeConn() as any) as unknown as FakeConn

    // Mount #1 releases (StrictMode's synthetic unmount)…
    release(key)
    // …and immediately, before the grace window, mount #2 re-acquires.
    const c2 = acquire(key, () => new FakeConn() as any) as unknown as FakeConn

    // The grace timer should have been cancelled — same instance, no disconnect.
    vi.advanceTimersByTime(1000)
    expect(c2).toBe(c1)
    expect(c1.disconnected).toBe(false)
    expect(FakeConn.instances).toBe(1)
  })

  it('disconnects after the grace window when no one re-acquires', () => {
    const key = poolKey({ url: 'ws://x/ws' })
    const c1 = acquire(key, () => new FakeConn() as any) as unknown as FakeConn
    release(key, 50)

    expect(c1.disconnected).toBe(false)
    vi.advanceTimersByTime(50)
    expect(c1.disconnected).toBe(true)
    expect(_poolSize()).toBe(0)
  })

  it('does not double-dispose with multiple releases', () => {
    const key = poolKey({ url: 'ws://x/ws' })
    const c1 = acquire(key, () => new FakeConn() as any) as unknown as FakeConn
    acquire(key, () => new FakeConn() as any)
    expect(_refcount(key)).toBe(2)

    release(key)
    release(key)
    expect(_refcount(key)).toBe(0)

    vi.advanceTimersByTime(100)
    expect(c1.disconnected).toBe(true)
  })

  it('release returns a no-op for unknown keys', () => {
    expect(() => release('unknown')()).not.toThrow()
  })
})
