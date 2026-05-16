// Edge-case coverage for the connection pool (issue #34).

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

describe('connection pool — concurrency (#34)', () => {
  it('handles many sequential mount/unmount cycles without leaks', () => {
    const key = poolKey({ url: 'ws://x/ws' })
    const created: FakeConn[] = []

    for (let i = 0; i < 50; i++) {
      const c = acquire(key, () => {
        const conn = new FakeConn()
        created.push(conn)
        return conn as any
      }) as unknown as FakeConn
      // Release immediately, then re-acquire within grace — should reuse.
      release(key)
      const c2 = acquire(key, () => new FakeConn() as any) as unknown as FakeConn
      expect(c2).toBe(c)
      release(key) // balance the second acquire
      release(key) // balance the first
    }

    expect(FakeConn.instances).toBe(1) // single instance kept alive the whole time
    expect(_refcount(key)).toBe(0)
    vi.advanceTimersByTime(1000)
    expect(_poolSize()).toBe(0)
    expect(created[0]!.disconnected).toBe(true)
  })

  it('creates a fresh connection after grace window expires', () => {
    const key = poolKey({ url: 'ws://x/ws' })
    const c1 = acquire(key, () => new FakeConn() as any) as unknown as FakeConn
    release(key)
    vi.advanceTimersByTime(100) // past grace window

    const c2 = acquire(key, () => new FakeConn() as any) as unknown as FakeConn
    expect(c2).not.toBe(c1)
    expect(c1.disconnected).toBe(true)
    expect(FakeConn.instances).toBe(2)
  })

  it('handles 3-deep refcount (multiple Providers same url) without disposing', () => {
    const key = poolKey({ url: 'ws://x/ws' })
    const c1 = acquire(key, () => new FakeConn() as any) as unknown as FakeConn
    acquire(key, () => new FakeConn() as any)
    acquire(key, () => new FakeConn() as any)
    expect(_refcount(key)).toBe(3)

    release(key)
    expect(_refcount(key)).toBe(2)
    release(key)
    expect(_refcount(key)).toBe(1)
    // Still alive — last release is the only one that arms the grace timer.
    vi.advanceTimersByTime(1000)
    expect(c1.disconnected).toBe(false)
    expect(_refcount(key)).toBe(1)
  })

  it('refcount cannot go negative on over-release', () => {
    const key = poolKey({ url: 'ws://x/ws' })
    acquire(key, () => new FakeConn() as any)
    release(key)
    release(key) // extra
    release(key) // extra
    expect(_refcount(key)).toBe(0)
  })

  it('disconnect throw is swallowed (does not crash the pool)', () => {
    const key = poolKey({ url: 'ws://x/ws' })
    class BadConn { disconnect() { throw new Error('boom') } }
    acquire(key, () => new BadConn() as any)
    release(key)
    expect(() => vi.advanceTimersByTime(100)).not.toThrow()
    expect(_poolSize()).toBe(0)
  })

  it('release returned canceller stops disposal when invoked', () => {
    const key = poolKey({ url: 'ws://x/ws' })
    const c = acquire(key, () => new FakeConn() as any) as unknown as FakeConn
    const cancel = release(key)
    cancel()
    vi.advanceTimersByTime(1000)
    expect(c.disconnected).toBe(false)
    expect(_poolSize()).toBe(1)
  })

  it('cancelling already-fired release is a no-op', () => {
    const key = poolKey({ url: 'ws://x/ws' })
    acquire(key, () => new FakeConn() as any)
    const cancel = release(key)
    vi.advanceTimersByTime(100) // fire
    expect(() => cancel()).not.toThrow()
  })
})

describe('connection pool — key composition (#34)', () => {
  it('null/undefined auth maps to the same key', () => {
    expect(poolKey({ url: 'ws://x' })).toBe(poolKey({ url: 'ws://x', auth: undefined }))
  })

  it('produces a stable string', () => {
    const k = poolKey({ url: 'ws://x', auth: { token: 'a' } as any })
    expect(typeof k).toBe('string')
    expect(k).toContain('ws://x')
  })

  it('handles unserializable auth without throwing', () => {
    const circular: any = {}
    circular.self = circular
    expect(() => poolKey({ url: 'ws://x', auth: circular })).not.toThrow()
  })

  it('different urls are isolated even when one of them has the same auth', () => {
    const auth = { token: 'shared' } as any
    expect(poolKey({ url: 'ws://a', auth })).not.toBe(poolKey({ url: 'ws://b', auth }))
  })
})

describe('connection pool — issue #34 simulation', () => {
  it('reproduces StrictMode mount → cleanup → mount and verifies one socket', () => {
    const key = poolKey({ url: 'ws://localhost/api/live/ws' })

    // First mount (StrictMode synthetic)
    const c1 = acquire(key, () => new FakeConn() as any)
    // First cleanup (StrictMode synthetic)
    release(key)
    // Second mount (the real one) — happens within microtasks, well inside grace
    const c2 = acquire(key, () => new FakeConn() as any)
    // No timer has fired yet — confirm identity:
    expect(c2).toBe(c1)
    expect(FakeConn.instances).toBe(1)

    // Even after a long time, while the component is mounted there's no disposal:
    vi.advanceTimersByTime(10_000)
    expect((c1 as any).disconnected).toBe(false)

    // Real unmount → after grace, dispose:
    release(key)
    vi.advanceTimersByTime(100)
    expect((c1 as any).disconnected).toBe(true)
    expect(_poolSize()).toBe(0)
  })
})
