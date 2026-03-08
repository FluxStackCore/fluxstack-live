// Cluster Adapter Integration Tests
//
// Tests cross-instance singleton coordination using 2 ComponentRegistries
// with real Redis (Docker: redis on port 16379).
//
// Verifies:
//   1. Singleton ownership claim (first server wins)
//   2. Remote proxy creation (second server gets proxy)
//   3. Action forwarding (proxy → owner via Redis pub/sub)
//   4. State delta broadcasting (owner → proxy via Redis pub/sub)
//   5. Cleanup & singleton release

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import Redis from 'ioredis'
import { ComponentRegistry } from '../../component/ComponentRegistry'
import { LiveComponent } from '../../component/LiveComponent'
import { setLiveComponentContext } from '../../component/context'
import { StateSignatureManager } from '../../security/StateSignature'
import { LiveAuthManager } from '../../auth/LiveAuthManager'
import { RoomEventBus } from '../../rooms/RoomEventBus'
import { LiveRoomManager } from '../../rooms/LiveRoomManager'
import { RedisClusterAdapter } from '../../../../redis/src/RedisClusterAdapter'
import { createMockWS, spyOnConsole } from '../helpers'

// ===== Test Singleton Component =====

class CounterSingleton extends LiveComponent<{ count: number }> {
  static componentName = 'CounterSingleton'
  static defaultState = { count: 0 }
  static singleton = true
  static publicActions = ['increment', 'decrement', 'set'] as const

  increment() {
    const count = (this.state as any).count + 1
    this.setState({ count })
    return { count }
  }

  decrement() {
    const count = (this.state as any).count - 1
    this.setState({ count })
    return { count }
  }

  set(payload: { count: number }) {
    this.setState({ count: payload.count })
    return { count: payload.count }
  }
}

// ===== Helper: create a test registry with cluster adapter =====

function createMocks() {
  return {
    debugger: {
      trackComponentMount: () => {},
      trackComponentUnmount: () => {},
      trackConnection: () => {},
      trackDisconnection: () => {},
      trackAction: () => {},
      trackStateChange: () => {},
      trackActionCall: () => {},
      trackActionResult: () => {},
      trackActionError: () => {},
      trackRoomEmit: () => {},
      isEnabled: false,
      enabled: false,
    },
    performanceMonitor: {
      initializeComponent: () => {},
      recordRenderTime: () => {},
      recordActionTime: () => {},
      removeComponent: () => {},
    },
  }
}

function createTestRegistryWithCluster(cluster: RedisClusterAdapter) {
  const roomEvents = new RoomEventBus()
  const roomManager = new LiveRoomManager(roomEvents)
  const authManager = new LiveAuthManager()
  const stateSignature = new StateSignatureManager({ secret: 'test-secret-32chars-minimum-ok!' })

  setLiveComponentContext({ roomEvents, roomManager })

  const { debugger: debugger_, performanceMonitor } = createMocks()

  const registry = new ComponentRegistry({
    authManager,
    debugger: debugger_ as any,
    stateSignature,
    performanceMonitor: performanceMonitor as any,
    cluster,
  })

  registry.registerComponentClass('CounterSingleton', CounterSingleton as any)

  return { registry, stateSignature, authManager }
}

// ===== Utility =====

function wait(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ===== Tests =====

const REDIS_PORT = 16379
const REDIS_HOST = '127.0.0.1'

describe('Cluster Sync - Integration (Real Redis)', () => {
  let redisA: Redis
  let redisB: Redis
  let clusterA: RedisClusterAdapter
  let clusterB: RedisClusterAdapter
  let registryA: ComponentRegistry
  let registryB: ComponentRegistry
  let consoleSpy: ReturnType<typeof spyOnConsole>

  beforeAll(async () => {
    // Verify Redis is reachable
    const testRedis = new Redis({ host: REDIS_HOST, port: REDIS_PORT, lazyConnect: true })
    try {
      await testRedis.connect()
      await testRedis.ping()
      await testRedis.disconnect()
    } catch {
      throw new Error(
        `Redis not available at ${REDIS_HOST}:${REDIS_PORT}. ` +
        `Run: docker run -d --name fluxstack-test-redis -p ${REDIS_PORT}:6379 redis:7-alpine`
      )
    }
  })

  beforeEach(async () => {
    consoleSpy = spyOnConsole()

    // Create 2 separate Redis connections (simulating 2 servers)
    redisA = new Redis({ host: REDIS_HOST, port: REDIS_PORT, db: 15 })
    redisB = new Redis({ host: REDIS_HOST, port: REDIS_PORT, db: 15 })

    // Flush test db
    await redisA.flushdb()

    // Create cluster adapters
    clusterA = new RedisClusterAdapter({
      redis: redisA,
      prefix: 'test:cluster:',
      stateTtl: 60,
      singletonTtl: 10,
      heartbeatInterval: 60_000, // long interval — we control timing manually
      actionTimeout: 5_000,
    })

    clusterB = new RedisClusterAdapter({
      redis: redisB,
      prefix: 'test:cluster:',
      stateTtl: 60,
      singletonTtl: 10,
      heartbeatInterval: 60_000,
      actionTimeout: 5_000,
    })

    // Start cluster adapters (subscribes to Redis channels)
    await clusterA.start()
    await clusterB.start()

    // Create registries
    const a = createTestRegistryWithCluster(clusterA)
    const b = createTestRegistryWithCluster(clusterB)
    registryA = a.registry
    registryB = b.registry

    // Small delay to let Redis subscriptions establish
    await wait(100)
  })

  afterEach(async () => {
    // Cleanup
    registryA.cleanup()
    registryB.cleanup()

    await clusterA.shutdown()
    await clusterB.shutdown()

    // Flush and disconnect
    try { await redisA.flushdb() } catch {}
    redisA.disconnect()
    redisB.disconnect()

    consoleSpy.restore()
  })

  // ── Test 1: Singleton Ownership ───────────────────────

  it('first server should claim singleton ownership', async () => {
    const ws1 = createMockWS()
    const result = await registryA.mountComponent(ws1, 'CounterSingleton')

    expect(result.componentId).toBeDefined()
    expect(result.initialState).toEqual({ count: 0 })

    // Verify it's a real local component
    const component = registryA.getComponent(result.componentId)
    expect(component).toBeDefined()

    // Verify Redis has the claim
    const owner = await clusterA.getSingletonOwner('CounterSingleton')
    expect(owner).not.toBeNull()
    expect(owner!.instanceId).toBe(clusterA.instanceId)
  })

  // ── Test 2: Remote Proxy ──────────────────────────────

  it('second server should create remote proxy for existing singleton', async () => {
    // Server A mounts singleton (becomes owner)
    const wsA = createMockWS()
    const resultA = await registryA.mountComponent(wsA, 'CounterSingleton')
    expect(resultA.componentId).toBeDefined()

    // Wait for Redis state to be saved
    await wait(50)

    // Server B mounts same singleton (should get proxy)
    const wsB = createMockWS()
    const resultB = await registryB.mountComponent(wsB, 'CounterSingleton')

    expect(resultB.componentId).toBeDefined()
    // Proxy should have the same componentId as the owner
    expect(resultB.componentId).toBe(resultA.componentId)
    // Component should NOT be in registryB's local components
    expect(registryB.getComponent(resultB.componentId)).toBeUndefined()

    // Stats should show remote singleton
    const stats = registryB.getStats()
    expect(stats.remoteSingletons).toBeDefined()
    expect(stats.remoteSingletons['CounterSingleton']).toBeDefined()
    expect(stats.remoteSingletons['CounterSingleton'].ownerInstanceId).toBe(clusterA.instanceId)
  })

  // ── Test 3: Action Forwarding ─────────────────────────

  it('should forward actions from proxy to owner via Redis', async () => {
    // Server A mounts singleton (owner)
    const wsA = createMockWS()
    const resultA = await registryA.mountComponent(wsA, 'CounterSingleton')

    await wait(50)

    // Server B mounts proxy
    const wsB = createMockWS()
    const resultB = await registryB.mountComponent(wsB, 'CounterSingleton')

    // Execute action on Server B (should be forwarded to Server A)
    const actionResult = await registryB.handleMessage(wsB, {
      type: 'CALL_ACTION',
      componentId: resultB.componentId,
      action: 'increment',
      payload: {},
      expectResponse: true,
      timestamp: Date.now(),
    })

    expect(actionResult).not.toBeNull()
    expect(actionResult!.success).toBe(true)
    expect(actionResult!.result).toEqual({ count: 1 })

    // Verify state changed on owner (Server A)
    const component = registryA.getComponent(resultA.componentId)
    expect(component).toBeDefined()
    expect((component!.getSerializableState() as any).count).toBe(1)
  })

  // ── Test 4: State Delta Broadcasting ──────────────────

  it('should broadcast state deltas from owner to proxy clients', async () => {
    // Server A mounts singleton (owner)
    const wsA = createMockWS()
    const resultA = await registryA.mountComponent(wsA, 'CounterSingleton')

    await wait(50)

    // Server B mounts proxy
    const wsB = createMockWS()
    await registryB.mountComponent(wsB, 'CounterSingleton')

    // Clear messages so we can track new ones
    wsB._messages.length = 0

    // Execute action on owner directly (state changes → delta published)
    await registryA.executeAction(resultA.componentId, 'increment', {})

    // Wait for Redis pub/sub propagation
    await wait(200)

    // Server B's WS should have received the STATE_DELTA
    const deltaMessages = wsB._messages
      .map(m => { try { return JSON.parse(m) } catch { return null } })
      .filter(m => m?.type === 'STATE_DELTA')

    expect(deltaMessages.length).toBeGreaterThanOrEqual(1)
    expect(deltaMessages[0].componentId).toBe(resultA.componentId)
    expect(deltaMessages[0].payload.delta).toBeDefined()
    expect(deltaMessages[0].payload.delta.count).toBe(1)
  })

  // ── Test 5: Multiple Actions ──────────────────────────

  it('should handle multiple forwarded actions in sequence', async () => {
    const wsA = createMockWS()
    const resultA = await registryA.mountComponent(wsA, 'CounterSingleton')

    await wait(50)

    const wsB = createMockWS()
    const resultB = await registryB.mountComponent(wsB, 'CounterSingleton')

    // Forward 3 increments from B to A
    for (let i = 0; i < 3; i++) {
      const r = await registryB.handleMessage(wsB, {
        type: 'CALL_ACTION',
        componentId: resultB.componentId,
        action: 'increment',
        payload: {},
        expectResponse: true,
        timestamp: Date.now(),
      })
      expect(r!.success).toBe(true)
    }

    // Verify owner state
    const component = registryA.getComponent(resultA.componentId)
    expect((component!.getSerializableState() as any).count).toBe(3)
  })

  // ── Test 6: Singleton Release ─────────────────────────

  it('should release singleton claim when last connection leaves', async () => {
    const wsA = createMockWS()
    const resultA = await registryA.mountComponent(wsA, 'CounterSingleton')

    // Verify claim exists
    let owner = await clusterA.getSingletonOwner('CounterSingleton')
    expect(owner).not.toBeNull()

    // Unmount (last connection)
    registryA.unmountComponent(resultA.componentId, wsA)

    // Wait for async release
    await wait(100)

    // Claim should be released
    owner = await clusterA.getSingletonOwner('CounterSingleton')
    expect(owner).toBeNull()
  })

  // ── Test 7: Failover — Claim After Release (with state recovery) ──

  it('second server can claim singleton after first releases and recover state', async () => {
    // Server A creates singleton and mutates state
    const wsA = createMockWS()
    const resultA = await registryA.mountComponent(wsA, 'CounterSingleton')
    await registryA.executeAction(resultA.componentId, 'set', { count: 42 })

    await wait(50)

    // Server A releases (graceful shutdown)
    registryA.unmountComponent(resultA.componentId, wsA)
    await wait(100)

    // Server B claims it — should recover state { count: 42 }
    const wsB = createMockWS()
    const resultB = await registryB.mountComponent(wsB, 'CounterSingleton')

    // Should be a local component (not proxy)
    const component = registryB.getComponent(resultB.componentId)
    expect(component).toBeDefined()

    // State should be recovered from Redis
    expect((component!.getSerializableState() as any).count).toBe(42)

    // Verify new claim is by B
    const owner = await clusterB.getSingletonOwner('CounterSingleton')
    expect(owner).not.toBeNull()
    expect(owner!.instanceId).toBe(clusterB.instanceId)
  })

  // ── Test 10: Crash Recovery — Owner Dies, State Survives ──

  it('should recover singleton state after owner crash (simulated TTL expiry)', async () => {
    // Server A creates singleton and mutates state
    const wsA = createMockWS()
    const resultA = await registryA.mountComponent(wsA, 'CounterSingleton')
    await registryA.executeAction(resultA.componentId, 'increment', {})
    await registryA.executeAction(resultA.componentId, 'increment', {})
    await registryA.executeAction(resultA.componentId, 'increment', {})

    await wait(50)

    // Verify state is { count: 3 }
    const comp = registryA.getComponent(resultA.componentId)
    expect((comp!.getSerializableState() as any).count).toBe(3)

    // Simulate owner crash: destroy registry without graceful unmount
    // (no releaseSingleton called, claim will expire via TTL)
    registryA.cleanup()

    // Manually delete the singleton claim to simulate TTL expiry
    // (in production this happens after singletonTtl seconds)
    await clusterA.releaseSingleton('CounterSingleton')
    await wait(50)

    // Server B comes along and mounts the singleton
    const wsB = createMockWS()
    const resultB = await registryB.mountComponent(wsB, 'CounterSingleton')

    // Should be a local component (B is now owner)
    const componentB = registryB.getComponent(resultB.componentId)
    expect(componentB).toBeDefined()

    // State should be recovered from singleton-state key: { count: 3 }
    expect((componentB!.getSerializableState() as any).count).toBe(3)
  })

  // ── Test 8: Connection Cleanup ────────────────────────

  it('should clean up remote proxy on connection close', async () => {
    const wsA = createMockWS()
    await registryA.mountComponent(wsA, 'CounterSingleton')

    await wait(50)

    const wsB = createMockWS()
    await registryB.mountComponent(wsB, 'CounterSingleton')

    // Verify proxy exists
    let stats = registryB.getStats()
    expect(Object.keys(stats.remoteSingletons).length).toBe(1)

    // Simulate B disconnect
    registryB.cleanupConnection(wsB)

    // Proxy should be cleaned up
    stats = registryB.getStats()
    expect(Object.keys(stats.remoteSingletons).length).toBe(0)
  })

  // ── Test 9: Multiple Proxy Clients ────────────────────

  it('should handle multiple proxy clients on same server', async () => {
    const wsA = createMockWS()
    const resultA = await registryA.mountComponent(wsA, 'CounterSingleton')

    await wait(50)

    // Two clients on server B
    const wsB1 = createMockWS()
    const wsB2 = createMockWS()
    const resultB1 = await registryB.mountComponent(wsB1, 'CounterSingleton')
    const resultB2 = await registryB.mountComponent(wsB2, 'CounterSingleton')

    // Both should get same componentId
    expect(resultB1.componentId).toBe(resultA.componentId)
    expect(resultB2.componentId).toBe(resultA.componentId)

    // Stats should show 2 connections
    const stats = registryB.getStats()
    expect(stats.remoteSingletons['CounterSingleton'].connections).toBe(2)

    // Disconnect one — proxy should remain
    registryB.cleanupConnection(wsB1)
    const stats2 = registryB.getStats()
    expect(stats2.remoteSingletons['CounterSingleton'].connections).toBe(1)

    // Disconnect last — proxy should be removed
    registryB.cleanupConnection(wsB2)
    const stats3 = registryB.getStats()
    expect(Object.keys(stats3.remoteSingletons).length).toBe(0)
  })
})
