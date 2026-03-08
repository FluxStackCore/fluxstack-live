// RedisClusterAdapter Unit Tests (Real Redis)
//
// Tests the Redis cluster adapter in isolation.
// Requires Docker Redis on port 16379:
//   docker run -d --name fluxstack-test-redis -p 16379:6379 redis:7-alpine

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import Redis from 'ioredis'
import { RedisClusterAdapter } from '../RedisClusterAdapter'

const REDIS_PORT = 16379
const REDIS_HOST = '127.0.0.1'

function wait(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('RedisClusterAdapter', () => {
  let redis: Redis
  let adapter: RedisClusterAdapter

  beforeAll(async () => {
    const test = new Redis({ host: REDIS_HOST, port: REDIS_PORT, lazyConnect: true })
    try {
      await test.connect()
      await test.ping()
      await test.disconnect()
    } catch {
      throw new Error(
        `Redis not available at ${REDIS_HOST}:${REDIS_PORT}. ` +
        `Run: docker run -d --name fluxstack-test-redis -p ${REDIS_PORT}:6379 redis:7-alpine`
      )
    }
  })

  beforeEach(async () => {
    redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT, db: 14 })
    await redis.flushdb()

    adapter = new RedisClusterAdapter({
      redis,
      prefix: 'test:unit:cluster:',
      stateTtl: 60,
      singletonTtl: 10,
      heartbeatInterval: 60_000,
      actionTimeout: 5_000,
    })
    await adapter.start()
  })

  afterEach(async () => {
    await adapter.shutdown()
    try { await redis.flushdb() } catch {}
    redis.disconnect()
  })

  // ── State Mirror ──────────────────────────────────

  describe('saveState / loadState / deleteState', () => {
    it('should save and load component state', async () => {
      await adapter.saveState('comp-1', 'Counter', { count: 5 })
      const loaded = await adapter.loadState('comp-1')

      expect(loaded).not.toBeNull()
      expect(loaded!.componentName).toBe('Counter')
      expect(loaded!.state).toEqual({ count: 5 })
      expect(loaded!.instanceId).toBe(adapter.instanceId)
      expect(loaded!.updatedAt).toBeGreaterThan(0)
    })

    it('should return null for non-existent state', async () => {
      const loaded = await adapter.loadState('non-existent')
      expect(loaded).toBeNull()
    })

    it('should delete component state', async () => {
      await adapter.saveState('comp-1', 'Counter', { count: 5 })
      await adapter.deleteState('comp-1')
      const loaded = await adapter.loadState('comp-1')
      expect(loaded).toBeNull()
    })

    it('should overwrite existing state', async () => {
      await adapter.saveState('comp-1', 'Counter', { count: 5 })
      await adapter.saveState('comp-1', 'Counter', { count: 10 })
      const loaded = await adapter.loadState('comp-1')
      expect(loaded!.state).toEqual({ count: 10 })
    })
  })

  // ── Singleton State ───────────────────────────────

  describe('saveSingletonState / loadSingletonState', () => {
    it('should save and load singleton state by name', async () => {
      await adapter.saveSingletonState('Counter', { count: 42 })
      const state = await adapter.loadSingletonState('Counter')
      expect(state).toEqual({ count: 42 })
    })

    it('should return null for non-existent singleton state', async () => {
      const state = await adapter.loadSingletonState('NonExistent')
      expect(state).toBeNull()
    })

    it('should overwrite singleton state', async () => {
      await adapter.saveSingletonState('Counter', { count: 1 })
      await adapter.saveSingletonState('Counter', { count: 99 })
      const state = await adapter.loadSingletonState('Counter')
      expect(state).toEqual({ count: 99 })
    })
  })

  // ── Singleton Claims ──────────────────────────────

  describe('claimSingleton / getSingletonOwner / releaseSingleton', () => {
    it('should claim a singleton successfully', async () => {
      const claim = await adapter.claimSingleton('Counter', 'comp-1')
      expect(claim.claimed).toBe(true)
      expect(claim.recoveredState).toBeUndefined()
    })

    it('should reject duplicate claims', async () => {
      await adapter.claimSingleton('Counter', 'comp-1')

      const adapter2 = new RedisClusterAdapter({
        redis: new Redis({ host: REDIS_HOST, port: REDIS_PORT, db: 14 }),
        prefix: 'test:unit:cluster:',
        singletonTtl: 10,
      })
      await adapter2.start()

      const claim = await adapter2.claimSingleton('Counter', 'comp-2')
      expect(claim.claimed).toBe(false)

      await adapter2.shutdown()
    })

    it('should return owner info', async () => {
      await adapter.claimSingleton('Counter', 'comp-1')
      const owner = await adapter.getSingletonOwner('Counter')

      expect(owner).not.toBeNull()
      expect(owner!.instanceId).toBe(adapter.instanceId)
      expect(owner!.componentId).toBe('comp-1')
    })

    it('should return null for unclaimed singleton', async () => {
      const owner = await adapter.getSingletonOwner('NonExistent')
      expect(owner).toBeNull()
    })

    it('should release a singleton claim', async () => {
      await adapter.claimSingleton('Counter', 'comp-1')
      await adapter.releaseSingleton('Counter')
      const owner = await adapter.getSingletonOwner('Counter')
      expect(owner).toBeNull()
    })

    it('should allow re-claim after release', async () => {
      await adapter.claimSingleton('Counter', 'comp-1')
      await adapter.releaseSingleton('Counter')
      const claim = await adapter.claimSingleton('Counter', 'comp-2')
      expect(claim.claimed).toBe(true)
    })

    it('should return recovered state on failover claim', async () => {
      // Simulate previous owner saving state then releasing
      await adapter.saveSingletonState('Counter', { count: 42 })
      await adapter.releaseSingleton('Counter')

      // New claim should include recovered state
      const claim = await adapter.claimSingleton('Counter', 'comp-new')
      expect(claim.claimed).toBe(true)
      expect(claim.recoveredState).toEqual({ count: 42 })
    })
  })

  // ── Ownership Verification ────────────────────────

  describe('verifySingletonOwnership', () => {
    it('should verify own ownership', async () => {
      await adapter.claimSingleton('Counter', 'comp-1')
      const owns = await adapter.verifySingletonOwnership('Counter')
      expect(owns).toBe(true)
    })

    it('should return false for unclaimed singleton', async () => {
      const owns = await adapter.verifySingletonOwnership('NonExistent')
      expect(owns).toBe(false)
    })

    it('should return false for other instances claim', async () => {
      const redis2 = new Redis({ host: REDIS_HOST, port: REDIS_PORT, db: 14 })
      const adapter2 = new RedisClusterAdapter({
        redis: redis2,
        prefix: 'test:unit:cluster:',
        singletonTtl: 10,
      })
      await adapter2.start()

      await adapter2.claimSingleton('Counter', 'comp-1')
      const owns = await adapter.verifySingletonOwnership('Counter')
      expect(owns).toBe(false)

      await adapter2.shutdown()
      redis2.disconnect()
    })
  })

  // ── Delta Pub/Sub ─────────────────────────────────

  describe('publishDelta / onDelta', () => {
    it('should receive deltas from other instances', async () => {
      const redis2 = new Redis({ host: REDIS_HOST, port: REDIS_PORT, db: 14 })
      const adapter2 = new RedisClusterAdapter({
        redis: redis2,
        prefix: 'test:unit:cluster:',
      })
      await adapter2.start()
      await wait(100)

      const received: any[] = []
      adapter2.onDelta((componentId, componentName, delta, origin) => {
        received.push({ componentId, componentName, delta, origin })
      })

      await adapter.publishDelta('comp-1', 'Counter', { count: 5 })
      await wait(200)

      expect(received.length).toBe(1)
      expect(received[0].componentId).toBe('comp-1')
      expect(received[0].componentName).toBe('Counter')
      expect(received[0].delta).toEqual({ count: 5 })
      expect(received[0].origin).toBe(adapter.instanceId)

      await adapter2.shutdown()
      redis2.disconnect()
    })

    it('should not receive own deltas (echo prevention)', async () => {
      const received: any[] = []
      adapter.onDelta((componentId, componentName, delta) => {
        received.push({ componentId, componentName, delta })
      })

      await adapter.publishDelta('comp-1', 'Counter', { count: 5 })
      await wait(200)

      expect(received.length).toBe(0)
    })
  })

  // ── Action Forwarding ─────────────────────────────

  describe('forwardAction / onActionForward', () => {
    it('should forward actions and receive responses', async () => {
      const redis2 = new Redis({ host: REDIS_HOST, port: REDIS_PORT, db: 14 })
      const adapter2 = new RedisClusterAdapter({
        redis: redis2,
        prefix: 'test:unit:cluster:',
        actionTimeout: 5_000,
      })
      await adapter2.start()
      await wait(100)

      // adapter2 handles actions
      adapter2.onActionForward(async (req) => {
        return {
          success: true,
          result: { count: 42 },
          requestId: req.requestId,
        }
      })

      // adapter forwards action to adapter2
      const response = await adapter.forwardAction({
        requestId: 'req-1',
        componentName: 'Counter',
        componentId: 'comp-1',
        action: 'increment',
        payload: {},
        sourceInstanceId: adapter.instanceId,
        targetInstanceId: adapter2.instanceId,
      })

      expect(response.success).toBe(true)
      expect(response.result).toEqual({ count: 42 })

      await adapter2.shutdown()
      redis2.disconnect()
    })

    it('should timeout if no response', async () => {
      const fastAdapter = new RedisClusterAdapter({
        redis: new Redis({ host: REDIS_HOST, port: REDIS_PORT, db: 14 }),
        prefix: 'test:unit:cluster:',
        actionTimeout: 500,
      })
      await fastAdapter.start()

      await expect(
        fastAdapter.forwardAction({
          requestId: 'req-timeout',
          componentName: 'Counter',
          componentId: 'comp-1',
          action: 'increment',
          payload: {},
          sourceInstanceId: fastAdapter.instanceId,
          targetInstanceId: 'non-existent-instance',
        })
      ).rejects.toThrow('timeout')

      await fastAdapter.shutdown()
    })
  })

  // ── Lifecycle ─────────────────────────────────────

  describe('start / shutdown', () => {
    it('should release all claims on shutdown', async () => {
      await adapter.claimSingleton('A', 'comp-a')
      await adapter.claimSingleton('B', 'comp-b')

      await adapter.shutdown()

      const ownerA = await redis.get('test:cluster:singleton:A')
      const ownerB = await redis.get('test:cluster:singleton:B')
      expect(ownerA).toBeNull()
      expect(ownerB).toBeNull()
    })

    it('should reject pending actions on shutdown', async () => {
      const promise = adapter.forwardAction({
        requestId: 'req-shutdown',
        componentName: 'Counter',
        componentId: 'comp-1',
        action: 'increment',
        payload: {},
        sourceInstanceId: adapter.instanceId,
        targetInstanceId: 'other-instance',
      })

      // Attach a no-op catch so the rejection is handled before vitest sees it
      promise.catch(() => {})

      await adapter.shutdown()

      await expect(promise).rejects.toThrow('shutting down')
    })

    it('should not start twice', async () => {
      // Already started in beforeEach
      await adapter.start() // Should be a no-op
      // No error = success
    })
  })
})
