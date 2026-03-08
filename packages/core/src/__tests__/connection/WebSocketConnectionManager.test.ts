// Tests for WebSocketConnectionManager — registration, pools, cleanup, stats
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WebSocketConnectionManager } from '../../connection/WebSocketConnectionManager'
import type { GenericWebSocket } from '../../transport/types'

// Mock LiveLogger
vi.mock('../../debug/LiveLogger', () => ({
  liveLog: vi.fn(),
  liveWarn: vi.fn(),
}))

function createMockWs(readyState = 1): GenericWebSocket {
  return {
    send: vi.fn(),
    close: vi.fn(),
    data: {} as any,
    remoteAddress: '127.0.0.1',
    readyState: readyState as any,
  } as any
}

describe('WebSocketConnectionManager', () => {
  let manager: WebSocketConnectionManager

  beforeEach(() => {
    vi.useFakeTimers()
    manager = new WebSocketConnectionManager({
      healthCheckInterval: 60_000,
      heartbeatInterval: 30_000,
    })
  })

  afterEach(() => {
    manager.shutdown()
    vi.useRealTimers()
  })

  describe('registerConnection()', () => {
    it('registers a new connection', () => {
      const ws = createMockWs()
      manager.registerConnection(ws, 'conn-1')

      const metrics = manager.getConnectionMetrics('conn-1')
      expect(metrics).not.toBeNull()
      expect(metrics!.id).toBe('conn-1')
      expect(metrics!.status).toBe('connected')
    })

    it('assigns connection to pool', () => {
      const ws = createMockWs()
      manager.registerConnection(ws, 'conn-1', 'pool-a')

      const stats = manager.getSystemStats()
      expect(stats.totalPools).toBe(1)
    })

    it('throws when max connections exceeded', () => {
      const smallManager = new WebSocketConnectionManager({
        maxConnections: 2,
        healthCheckInterval: 999_999,
        heartbeatInterval: 999_999,
      })

      smallManager.registerConnection(createMockWs(), 'c1')
      smallManager.registerConnection(createMockWs(), 'c2')

      expect(() => smallManager.registerConnection(createMockWs(), 'c3'))
        .toThrow('Maximum connections exceeded')

      smallManager.shutdown()
    })

    it('emits connectionRegistered event', () => {
      const handler = vi.fn()
      manager.on('connectionRegistered', handler)

      manager.registerConnection(createMockWs(), 'conn-1', 'pool-a')

      expect(handler).toHaveBeenCalledWith({ connectionId: 'conn-1', poolId: 'pool-a' })
    })
  })

  describe('addToPool() / removeFromPool()', () => {
    it('adds connection to pool', () => {
      const ws = createMockWs()
      manager.registerConnection(ws, 'conn-1')
      manager.addToPool('conn-1', 'pool-a')
      manager.addToPool('conn-1', 'pool-b')

      const stats = manager.getSystemStats()
      expect(stats.totalPools).toBe(2)
    })

    it('removes connection from pool', () => {
      const ws = createMockWs()
      manager.registerConnection(ws, 'conn-1')
      manager.addToPool('conn-1', 'pool-a')
      manager.removeFromPool('conn-1', 'pool-a')

      const stats = manager.getSystemStats()
      expect(stats.totalPools).toBe(0)
    })
  })

  describe('cleanupConnection()', () => {
    it('removes connection and its metrics', () => {
      manager.registerConnection(createMockWs(), 'conn-1')
      manager.cleanupConnection('conn-1')

      expect(manager.getConnectionMetrics('conn-1')).toBeNull()
      expect(manager.getSystemStats().totalConnections).toBe(0)
    })

    it('cleans up pool memberships via reverse index', () => {
      manager.registerConnection(createMockWs(), 'conn-1', 'pool-a')
      manager.addToPool('conn-1', 'pool-b')

      manager.cleanupConnection('conn-1')

      expect(manager.getSystemStats().totalPools).toBe(0)
    })
  })

  describe('getSystemStats()', () => {
    it('returns accurate system statistics', () => {
      manager.registerConnection(createMockWs(1), 'conn-1')
      manager.registerConnection(createMockWs(1), 'conn-2')
      manager.registerConnection(createMockWs(3), 'conn-3') // closed

      const stats = manager.getSystemStats()
      expect(stats.totalConnections).toBe(3)
      expect(stats.activeConnections).toBe(2)
      expect(stats.connectionUtilization).toBeGreaterThan(0)
    })
  })

  describe('getAllConnectionMetrics()', () => {
    it('returns all connection metrics', () => {
      manager.registerConnection(createMockWs(), 'conn-1')
      manager.registerConnection(createMockWs(), 'conn-2')

      const metrics = manager.getAllConnectionMetrics()
      expect(metrics).toHaveLength(2)
    })
  })

  describe('shutdown()', () => {
    it('closes all connections and clears state', () => {
      const ws1 = createMockWs()
      const ws2 = createMockWs()
      manager.registerConnection(ws1, 'conn-1')
      manager.registerConnection(ws2, 'conn-2')

      manager.shutdown()

      expect(ws1.close).toHaveBeenCalled()
      expect(ws2.close).toHaveBeenCalled()
      expect(manager.getSystemStats().totalConnections).toBe(0)
    })
  })
})
