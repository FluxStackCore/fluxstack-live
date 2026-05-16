// Client-side session mirror must be frozen so accidental writes
// (`proxy.$auth.session.plan = 'enterprise'`) cannot silently corrupt
// the shared reference shared across React subscribers.
//
// Mirrors the server-side AuthenticatedContext deep-freeze. Note: this
// only protects against LOCAL mutation in the browser — it has no
// security value (the server doesn't trust client state), but it's a
// correctness/sanity guarantee against bugs.
//
// Coverage targets the three places where auth.session is set:
//   1. CONNECTION_ESTABLISHED handler auto-sending AUTH
//   2. Standalone AUTH_RESPONSE handler
//   3. Public authenticate() method (manual re-auth via Provider)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LiveConnection } from '../connection'

class MockWebSocket {
  static instances: MockWebSocket[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readyState = 0
  binaryType = 'arraybuffer'
  onopen: ((ev?: any) => void) | null = null
  onclose: ((ev?: any) => void) | null = null
  onerror: ((ev?: any) => void) | null = null
  onmessage: ((ev?: any) => void) | null = null
  send = vi.fn()
  close = vi.fn(function (this: MockWebSocket) {
    this.readyState = 3
    this.onclose?.({ code: 1000, reason: '' })
  })
  constructor(public url: string) {
    MockWebSocket.instances.push(this)
  }
}

beforeEach(() => {
  MockWebSocket.instances = []
  ;(globalThis as any).WebSocket = MockWebSocket
})

afterEach(() => {
  // no fake timers — we use real async with explicit awaits
})

/** Subscribe to state and capture the latest auth snapshot. */
function trackAuth(conn: LiveConnection) {
  const snapshots: Array<{ authenticated: boolean; session: any }> = []
  conn.onStateChange((s) => {
    snapshots.push({ authenticated: s.auth.authenticated, session: s.auth.session })
  })
  return {
    last: () => snapshots[snapshots.length - 1],
    all: () => snapshots,
  }
}

describe('client session mirror — deep frozen (#auth)', () => {
  it('AUTH_RESPONSE session is frozen at the top level', async () => {
    const conn = new LiveConnection({ url: 'ws://test/ws', autoConnect: true })
    const auth = trackAuth(conn)

    const ws = MockWebSocket.instances[0]!
    ws.readyState = 1
    ws.onopen?.()

    ws.onmessage?.({
      data: JSON.stringify({
        type: 'AUTH_RESPONSE',
        payload: {
          authenticated: true,
          session: {
            id: 'usr-1',
            email: 'a@b.com',
            plan: 'enterprise',
            roles: ['admin', 'user'],
            permissions: ['users.read'],
            nested: { orgId: 'org-7', tier: 'gold' },
          },
        },
      }),
    })

    expect(Object.isFrozen(auth.last().session)).toBe(true)
    conn.destroy()
  })

  it('nested objects and arrays inside session are also frozen', async () => {
    const conn = new LiveConnection({ url: 'ws://test/ws', autoConnect: true })
    const auth = trackAuth(conn)

    const ws = MockWebSocket.instances[0]!
    ws.readyState = 1
    ws.onopen?.()

    ws.onmessage?.({
      data: JSON.stringify({
        type: 'AUTH_RESPONSE',
        payload: {
          authenticated: true,
          session: { id: 'u-1', org: { id: 'org-7', plan: 'enterprise' }, roles: ['admin'] },
        },
      }),
    })

    const s = auth.last().session
    expect(Object.isFrozen(s.org)).toBe(true)
    expect(Object.isFrozen(s.roles)).toBe(true)
    conn.destroy()
  })

  it('mutating a top-level field throws in strict mode', async () => {
    const conn = new LiveConnection({ url: 'ws://test/ws', autoConnect: true })
    const auth = trackAuth(conn)

    const ws = MockWebSocket.instances[0]!
    ws.readyState = 1
    ws.onopen?.()

    ws.onmessage?.({
      data: JSON.stringify({
        type: 'AUTH_RESPONSE',
        payload: { authenticated: true, session: { id: 'u-1', plan: 'free' } },
      }),
    })

    const s = auth.last().session
    expect(() => { s.plan = 'enterprise-HACKED' }).toThrow()
    expect(s.plan).toBe('free')
    conn.destroy()
  })

  it('pushing to roles array throws', async () => {
    const conn = new LiveConnection({ url: 'ws://test/ws', autoConnect: true })
    const auth = trackAuth(conn)

    const ws = MockWebSocket.instances[0]!
    ws.readyState = 1
    ws.onopen?.()

    ws.onmessage?.({
      data: JSON.stringify({
        type: 'AUTH_RESPONSE',
        payload: { authenticated: true, session: { id: 'u-1', roles: ['user'] } },
      }),
    })

    const s = auth.last().session
    expect(() => { s.roles.push('admin') }).toThrow()
    expect(s.roles).toEqual(['user'])
    conn.destroy()
  })

  it('adding a brand-new field throws', async () => {
    const conn = new LiveConnection({ url: 'ws://test/ws', autoConnect: true })
    const auth = trackAuth(conn)

    const ws = MockWebSocket.instances[0]!
    ws.readyState = 1
    ws.onopen?.()

    ws.onmessage?.({
      data: JSON.stringify({
        type: 'AUTH_RESPONSE',
        payload: { authenticated: true, session: { id: 'u-1' } },
      }),
    })

    const s = auth.last().session
    expect(() => { s.injected = 'BAD' }).toThrow()
    expect(s.injected).toBeUndefined()
    conn.destroy()
  })

  it('null session (logout / failed auth) is fine — no freeze attempted', async () => {
    const conn = new LiveConnection({ url: 'ws://test/ws', autoConnect: true })
    const auth = trackAuth(conn)

    const ws = MockWebSocket.instances[0]!
    ws.readyState = 1
    ws.onopen?.()

    ws.onmessage?.({
      data: JSON.stringify({
        type: 'AUTH_RESPONSE',
        payload: { authenticated: false, session: null },
      }),
    })

    expect(auth.last().session).toBeNull()
    conn.destroy()
  })

  it('deeply nested object is frozen up to a bounded depth (no infinite loop)', async () => {
    const conn = new LiveConnection({ url: 'ws://test/ws', autoConnect: true })
    const auth = trackAuth(conn)

    const ws = MockWebSocket.instances[0]!
    ws.readyState = 1
    ws.onopen?.()

    const deep: any = { id: 'u' }
    let cur = deep
    for (let i = 0; i < 50; i++) {
      cur.next = { i }
      cur = cur.next
    }
    ws.onmessage?.({
      data: JSON.stringify({ type: 'AUTH_RESPONSE', payload: { authenticated: true, session: deep } }),
    })

    const s = auth.last().session
    expect(Object.isFrozen(s)).toBe(true)
    // Walker bounded at depth 8 — anything deeper may still be mutable, but
    // it must NOT have hung the call:
    conn.destroy()
  })

  it('authenticate() public method also freezes the resulting session', async () => {
    // This is the path Provider's `authenticate()` exposed to apps takes.
    const conn = new LiveConnection({ url: 'ws://test/ws', autoConnect: true })
    const auth = trackAuth(conn)

    const ws = MockWebSocket.instances[0]!
    ws.readyState = 1
    ws.onopen?.()

    // Trigger conn.authenticate() — it sends a message and awaits the response.
    const authPromise = conn.authenticate({ token: 'jwt-abc' })

    // Simulate the server replying with the request's requestId.
    // We need to peek at what was sent to know the requestId.
    const lastSend = ws.send.mock.calls[ws.send.mock.calls.length - 1]?.[0]
    expect(typeof lastSend).toBe('string')
    const reqMsg = JSON.parse(lastSend)
    const reqId = reqMsg.requestId
    expect(reqId).toBeTruthy()

    ws.onmessage?.({
      data: JSON.stringify({
        type: 'AUTH_RESPONSE',
        requestId: reqId,
        success: true,
        payload: { authenticated: true, session: { id: 'u-1', plan: 'pro' } },
      }),
    })

    const ok = await authPromise
    expect(ok).toBe(true)

    const s = auth.last().session
    expect(Object.isFrozen(s)).toBe(true)
    expect(() => { s.plan = 'enterprise' }).toThrow()
    conn.destroy()
  })
})
