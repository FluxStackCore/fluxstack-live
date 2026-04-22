// Regression: reconnect() scheduled a setTimeout(connect, 100) that
// survived destroy() — causing a socket leak when a component unmounted
// right after reconnecting (common under React Strict Mode or route
// changes during a reconnect).

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
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('LiveConnection reconnect/destroy race', () => {
  it('destroy() cancels pending manual reconnect timeout', () => {
    const conn = new LiveConnection({ url: 'ws://test', autoConnect: false })
    conn.connect()
    expect(MockWebSocket.instances).toHaveLength(1)

    conn.reconnect()
    conn.destroy()

    // Advance past the 100ms manual reconnect delay
    vi.advanceTimersByTime(500)

    // Must NOT have created a second WebSocket after destroy
    expect(MockWebSocket.instances).toHaveLength(1)
  })

  it('reconnect() after destroy() is a no-op', () => {
    const conn = new LiveConnection({ url: 'ws://test', autoConnect: false })
    conn.destroy()
    conn.reconnect()
    vi.advanceTimersByTime(500)
    expect(MockWebSocket.instances).toHaveLength(0)
  })

  it('reconnect() cancels a prior pending manual reconnect (no double-connect)', () => {
    const conn = new LiveConnection({ url: 'ws://test', autoConnect: false })
    conn.connect()
    conn.reconnect()
    conn.reconnect()
    vi.advanceTimersByTime(500)
    // 1 initial + 1 from the last reconnect = 2 (not 3)
    expect(MockWebSocket.instances.length).toBeLessThanOrEqual(2)
    conn.destroy()
  })
})
