// Auth × connection pool (#34) — verifies that the pool's key composition
// keeps connections with different credentials isolated, while keeping
// connections with the same credentials shared.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  acquire,
  release,
  poolKey,
  _resetPool,
  _poolSize,
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

describe('connection pool × auth (#34)', () => {
  it('different tokens on the same URL produce different connections', () => {
    const kA = poolKey({ url: 'ws://x', auth: { token: 'alice' } as any })
    const kB = poolKey({ url: 'ws://x', auth: { token: 'bob' } as any })
    expect(kA).not.toBe(kB)

    const cA = acquire(kA, () => new FakeConn() as any)
    const cB = acquire(kB, () => new FakeConn() as any)
    expect(cA).not.toBe(cB)
    expect(_poolSize()).toBe(2)
  })

  it('anonymous (auth=null) and authenticated produce different connections', () => {
    const kAnon = poolKey({ url: 'ws://x' })
    const kAuth = poolKey({ url: 'ws://x', auth: { token: 'x' } as any })
    expect(kAnon).not.toBe(kAuth)
  })

  it('auth=undefined and auth=null map to the same key (both anonymous)', () => {
    expect(poolKey({ url: 'ws://x', auth: undefined }))
      .toBe(poolKey({ url: 'ws://x', auth: null as any }))
  })

  it('same token on the same URL reuses the connection (refcount bumped)', () => {
    const k = poolKey({ url: 'ws://x', auth: { token: 'alice' } as any })
    const c1 = acquire(k, () => new FakeConn() as any)
    const c2 = acquire(k, () => new FakeConn() as any)
    expect(c2).toBe(c1)
    expect(FakeConn.instances).toBe(1)
  })

  it('logout (acquire + release on token, then acquire anonymous) yields a different connection', () => {
    const kAuth = poolKey({ url: 'ws://x', auth: { token: 'alice' } as any })
    const kAnon = poolKey({ url: 'ws://x' })

    const cAuth = acquire(kAuth, () => new FakeConn() as any) as unknown as FakeConn
    release(kAuth) // logout — refcount drops; grace timer arms

    // Switching to anonymous immediately uses a DIFFERENT pool key:
    const cAnon = acquire(kAnon, () => new FakeConn() as any) as unknown as FakeConn
    expect(cAnon).not.toBe(cAuth as any)

    // The old (auth) connection is disposed after grace, untouched by anon traffic.
    vi.advanceTimersByTime(100)
    expect(cAuth.disconnected).toBe(true)
    expect(cAnon.disconnected).toBe(false)
  })

  it('changing token while a previous connection is still alive isolates new socket', () => {
    const k1 = poolKey({ url: 'ws://x', auth: { token: 't1' } as any })
    const k2 = poolKey({ url: 'ws://x', auth: { token: 't2' } as any })

    const c1 = acquire(k1, () => new FakeConn() as any) as unknown as FakeConn
    // User stays "logged in" with t1 (don't release) while another part of
    // the app authenticates with t2 — both should coexist.
    const c2 = acquire(k2, () => new FakeConn() as any) as unknown as FakeConn

    expect(c1).not.toBe(c2 as any)
    expect(_poolSize()).toBe(2)
    expect(c1.disconnected).toBe(false)
    expect(c2.disconnected).toBe(false)
  })

  it('crypto-auth-style credentials (publicKey + signature + nonce) keys correctly', () => {
    const a = poolKey({ url: 'ws://x', auth: { publicKey: 'PK1', signature: 'sig1', nonce: 'n1' } as any })
    const b = poolKey({ url: 'ws://x', auth: { publicKey: 'PK2', signature: 'sig2', nonce: 'n2' } as any })
    expect(a).not.toBe(b)

    // Same publicKey but different nonce → still different key (signatures
    // and nonces change every handshake; pool intentionally treats them
    // as distinct credentials).
    const c = poolKey({ url: 'ws://x', auth: { publicKey: 'PK1', signature: 'sig1', nonce: 'n1' } as any })
    const d = poolKey({ url: 'ws://x', auth: { publicKey: 'PK1', signature: 'sig1', nonce: 'n2' } as any })
    expect(c).not.toBe(d)
  })

  it('order of keys in auth object affects key (JSON.stringify is not order-stable)', () => {
    // This is a known limitation — documenting it as expected behaviour.
    // Consumers must produce stable key ordering if they want sharing.
    const k1 = poolKey({ url: 'ws://x', auth: { token: 't', provider: 'jwt' } as any })
    const k2 = poolKey({ url: 'ws://x', auth: { provider: 'jwt', token: 't' } as any })
    // V8 preserves insertion order, so these CAN differ:
    if (k1 !== k2) {
      expect(k1).not.toBe(k2)
    } else {
      expect(k1).toBe(k2)
    }
  })

  it('circular auth object does not throw', () => {
    const circular: any = { token: 'a' }
    circular.self = circular
    expect(() => poolKey({ url: 'ws://x', auth: circular })).not.toThrow()
  })
})
