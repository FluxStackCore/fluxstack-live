// Bug hunt: WebSocketConnectionManager — duplicate registration, pool
// indexing consistency, cleanup completeness, maxConnections enforcement.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { WebSocketConnectionManager } from '../../connection/WebSocketConnectionManager'

vi.mock('../../debug/LiveLogger', () => ({
  liveLog: vi.fn(),
  liveWarn: vi.fn(),
}))

function mockWS(readyState = 1) {
  return { readyState, send: () => {}, close: () => {} } as any
}

let mgr: WebSocketConnectionManager
beforeEach(() => {
  mgr = new WebSocketConnectionManager({
    maxConnections: 5,
    healthCheckInterval: 999_999,
    heartbeatInterval: 999_999,
  })
})
afterEach(() => { mgr?.shutdown() })

describe('registerConnection', () => {
  it('rejects when maxConnections is exceeded', () => {
    for (let i = 0; i < 5; i++) mgr.registerConnection(mockWS(), `c-${i}`)
    expect(() => mgr.registerConnection(mockWS(), 'overflow')).toThrow(/Maximum connections exceeded/)
  })

  it('🔍 duplicate connectionId silently overwrites the previous registration', () => {
    const wsA = mockWS()
    const wsB = mockWS()
    mgr.registerConnection(wsA, 'dup')
    // The previous metrics object is replaced by a fresh one — any counters
    // accumulated against the old registration are lost. This documents the
    // current behavior so a future "reject duplicates" change knows what to
    // break.
    mgr.registerConnection(wsB, 'dup')
    const stats = mgr.getSystemStats()
    expect(stats.totalConnections).toBe(1) // overwrote in place
    // The newer registration is the one held:
    const metrics = mgr.getConnectionMetrics('dup')
    expect(metrics).toBeTruthy()
    expect(metrics!.messagesSent).toBe(0) // fresh counters
  })

  it('initializes metrics with all required fields', () => {
    mgr.registerConnection(mockWS(), 'c-1')
    const m = mgr.getConnectionMetrics('c-1')
    expect(m).toMatchObject({
      id: 'c-1',
      status: 'connected',
      messagesSent: 0,
      messagesReceived: 0,
      bytesTransferred: 0,
      latency: 0,
      errorCount: 0,
      reconnectCount: 0,
    })
    expect(m!.connectedAt).toBeInstanceOf(Date)
  })

  it('emits connectionRegistered event with id and pool', () => {
    const events: any[] = []
    mgr.on('connectionRegistered', e => events.push(e))
    mgr.registerConnection(mockWS(), 'c-1', 'pool-A')
    expect(events).toEqual([{ connectionId: 'c-1', poolId: 'pool-A' }])
  })
})

describe('addToPool / removeFromPool', () => {
  it('adds a connection to multiple pools', () => {
    mgr.registerConnection(mockWS(), 'c-1')
    mgr.addToPool('c-1', 'P1')
    mgr.addToPool('c-1', 'P2')
    const stats = mgr.getSystemStats()
    expect(stats.totalPools).toBe(2)
  })

  it('removeFromPool removes only from the specified pool', () => {
    mgr.registerConnection(mockWS(), 'c-1')
    mgr.addToPool('c-1', 'P1')
    mgr.addToPool('c-1', 'P2')
    mgr.removeFromPool('c-1', 'P1')
    expect(mgr.getSystemStats().totalPools).toBe(1)
  })

  it('removeFromPool deletes the pool when it becomes empty', () => {
    mgr.registerConnection(mockWS(), 'c-1')
    mgr.registerConnection(mockWS(), 'c-2')
    mgr.addToPool('c-1', 'P1')
    mgr.addToPool('c-2', 'P1')
    mgr.removeFromPool('c-1', 'P1')
    expect(mgr.getSystemStats().totalPools).toBe(1) // P1 still has c-2
    mgr.removeFromPool('c-2', 'P1')
    expect(mgr.getSystemStats().totalPools).toBe(0) // empty pool removed
  })

  it('addToPool twice for same (conn, pool) is idempotent', () => {
    mgr.registerConnection(mockWS(), 'c-1')
    mgr.addToPool('c-1', 'P')
    mgr.addToPool('c-1', 'P')
    mgr.removeFromPool('c-1', 'P')
    // One remove should fully clear, not leave a phantom membership.
    expect(mgr.getSystemStats().totalPools).toBe(0)
  })

  it('removeFromPool on unknown pool is a no-op', () => {
    mgr.registerConnection(mockWS(), 'c-1')
    expect(() => mgr.removeFromPool('c-1', 'ghost')).not.toThrow()
  })
})

describe('cleanupConnection', () => {
  it('removes the connection, metrics, and queue', () => {
    mgr.registerConnection(mockWS(), 'c-1')
    mgr.cleanupConnection('c-1')
    expect(mgr.getConnectionMetrics('c-1')).toBeNull()
    expect(mgr.getSystemStats().totalConnections).toBe(0)
  })

  it('removes the connection from ALL pools it was in', () => {
    mgr.registerConnection(mockWS(), 'c-1')
    mgr.addToPool('c-1', 'P1')
    mgr.addToPool('c-1', 'P2')
    mgr.addToPool('c-1', 'P3')
    mgr.cleanupConnection('c-1')
    expect(mgr.getSystemStats().totalPools).toBe(0)
  })

  it('does not touch other connections sharing the same pools', () => {
    mgr.registerConnection(mockWS(), 'c-1')
    mgr.registerConnection(mockWS(), 'c-2')
    mgr.addToPool('c-1', 'shared')
    mgr.addToPool('c-2', 'shared')
    mgr.cleanupConnection('c-1')
    expect(mgr.getConnectionMetrics('c-2')).toBeTruthy()
    expect(mgr.getSystemStats().totalPools).toBe(1)
  })

  it('cleanupConnection on unknown id is a no-op', () => {
    expect(() => mgr.cleanupConnection('ghost')).not.toThrow()
    expect(mgr.getSystemStats().totalConnections).toBe(0)
  })

  it('🔍 cleanup followed by re-register with the same id starts fresh', () => {
    mgr.registerConnection(mockWS(), 'c-1')
    mgr.addToPool('c-1', 'P')
    mgr.cleanupConnection('c-1')
    mgr.registerConnection(mockWS(), 'c-1') // fresh start
    expect(mgr.getConnectionMetrics('c-1')!.messagesSent).toBe(0)
    expect(mgr.getSystemStats().totalPools).toBe(0) // no leaked pool membership
  })
})

describe('getSystemStats', () => {
  it('reports active vs total separately based on readyState', () => {
    mgr.registerConnection(mockWS(1), 'open')
    mgr.registerConnection(mockWS(3), 'closed') // readyState 3 = CLOSED
    const stats = mgr.getSystemStats()
    expect(stats.totalConnections).toBe(2)
    expect(stats.activeConnections).toBe(1)
  })

  it('counts queued messages across all connection queues', () => {
    mgr.registerConnection(mockWS(), 'c-1')
    mgr.registerConnection(mockWS(), 'c-2')
    // Without a public API to push messages we just confirm zero queues.
    expect(mgr.getSystemStats().totalQueuedMessages).toBe(0)
  })
})

describe('getAllConnectionMetrics', () => {
  it('returns a snapshot of every registered metrics object', () => {
    mgr.registerConnection(mockWS(), 'a')
    mgr.registerConnection(mockWS(), 'b')
    const all = mgr.getAllConnectionMetrics()
    expect(all.map(m => m.id).sort()).toEqual(['a', 'b'])
  })

  it('returns an empty array when nothing is registered', () => {
    expect(mgr.getAllConnectionMetrics()).toEqual([])
  })
})

describe('shutdown', () => {
  it('clears health and heartbeat timers (no leak)', () => {
    // Just confirm it doesn't throw and getSystemStats still works after.
    mgr.shutdown()
    expect(() => mgr.getSystemStats()).not.toThrow()
  })

  it('shutdown is idempotent', () => {
    mgr.shutdown()
    expect(() => mgr.shutdown()).not.toThrow()
  })
})
