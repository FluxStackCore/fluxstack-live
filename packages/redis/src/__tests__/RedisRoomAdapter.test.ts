// RedisRoomAdapter Unit Tests (Real Redis)
//
// Tests the Redis room pub/sub adapter in isolation.
// Requires Docker Redis on port 16379:
//   docker run -d --name fluxstack-test-redis -p 16379:6379 redis:7-alpine

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import Redis from 'ioredis'
import { RedisRoomAdapter } from '../RedisRoomAdapter'

const REDIS_PORT = 16379
const REDIS_HOST = '127.0.0.1'

function wait(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('RedisRoomAdapter', () => {
  let redis: Redis
  let adapter: RedisRoomAdapter

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
    redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT, db: 13 })
    await redis.flushdb()

    adapter = new RedisRoomAdapter({
      redis,
      prefix: 'test:room:',
      stateTtl: 60,
    })
  })

  afterEach(async () => {
    await adapter.shutdown()
    try { await redis.flushdb() } catch {}
    redis.disconnect()
  })

  // ── Pub/Sub ───────────────────────────────────────

  describe('publish / subscribe', () => {
    it('should receive events from other instances', async () => {
      const redis2 = new Redis({ host: REDIS_HOST, port: REDIS_PORT, db: 13 })
      const adapter2 = new RedisRoomAdapter({
        redis: redis2,
        prefix: 'test:room:',
      })

      const received: any[] = []
      await adapter.subscribe('room-1', (event, data) => {
        received.push({ event, data })
      })

      await wait(100)

      await adapter2.publish('room-1', 'message:new', { text: 'hello' })
      await wait(200)

      expect(received.length).toBe(1)
      expect(received[0].event).toBe('message:new')
      expect(received[0].data).toEqual({ text: 'hello' })

      await adapter2.shutdown()
      redis2.disconnect()
    })

    it('should not receive own events (echo prevention)', async () => {
      const received: any[] = []
      await adapter.subscribe('room-1', (event, data) => {
        received.push({ event, data })
      })

      await wait(100)
      await adapter.publish('room-1', 'message:new', { text: 'hello' })
      await wait(200)

      expect(received.length).toBe(0)
    })

    it('should unsubscribe correctly', async () => {
      const received: any[] = []
      const unsub = await adapter.subscribe('room-1', (event, data) => {
        received.push({ event, data })
      })

      await wait(100)
      unsub()
      await wait(50)

      const redis2 = new Redis({ host: REDIS_HOST, port: REDIS_PORT, db: 13 })
      const adapter2 = new RedisRoomAdapter({ redis: redis2, prefix: 'test:room:' })

      await adapter2.publish('room-1', 'message:new', { text: 'after unsub' })
      await wait(200)

      expect(received.length).toBe(0)

      await adapter2.shutdown()
      redis2.disconnect()
    })

    it('should handle multiple handlers for same room', async () => {
      const received1: any[] = []
      const received2: any[] = []

      await adapter.subscribe('room-1', (event, data) => {
        received1.push({ event, data })
      })
      await adapter.subscribe('room-1', (event, data) => {
        received2.push({ event, data })
      })

      await wait(100)

      const redis2 = new Redis({ host: REDIS_HOST, port: REDIS_PORT, db: 13 })
      const adapter2 = new RedisRoomAdapter({ redis: redis2, prefix: 'test:room:' })

      await adapter2.publish('room-1', 'test', { x: 1 })
      await wait(200)

      expect(received1.length).toBe(1)
      expect(received2.length).toBe(1)

      await adapter2.shutdown()
      redis2.disconnect()
    })
  })

  // ── Membership ────────────────────────────────────

  describe('publishMembership', () => {
    it('should broadcast membership events', async () => {
      const redis2 = new Redis({ host: REDIS_HOST, port: REDIS_PORT, db: 13 })
      const adapter2 = new RedisRoomAdapter({ redis: redis2, prefix: 'test:room:' })

      const received: any[] = []
      await adapter2.subscribe('room-1', (event, data) => {
        received.push({ event, data })
      })

      await wait(100)

      await adapter.publishMembership('room-1', 'join', 'comp-1')
      await wait(200)

      expect(received.length).toBe(1)
      expect(received[0].event).toBe('$sub:join')
      expect(received[0].data.subscriberId).toBe('comp-1')

      await adapter2.shutdown()
      redis2.disconnect()
    })
  })

  // ── State Persistence ─────────────────────────────

  describe('publishStateChange / getPersistedState / deletePersistedState', () => {
    it('should persist and retrieve room state', async () => {
      await adapter.publishStateChange('room-1', { count: 5, name: 'test' })
      const state = await adapter.getPersistedState('room-1')

      expect(state).toEqual({ count: 5, name: 'test' })
    })

    it('should merge state updates', async () => {
      await adapter.publishStateChange('room-1', { count: 5 })
      await adapter.publishStateChange('room-1', { name: 'test' })
      const state = await adapter.getPersistedState('room-1')

      expect(state).toEqual({ count: 5, name: 'test' })
    })

    it('should return null for non-existent room state', async () => {
      const state = await adapter.getPersistedState('non-existent')
      expect(state).toBeNull()
    })

    it('should delete persisted state', async () => {
      await adapter.publishStateChange('room-1', { count: 5 })
      const deleted = await adapter.deletePersistedState('room-1')
      expect(deleted).toBe(true)

      const state = await adapter.getPersistedState('room-1')
      expect(state).toBeNull()
    })

    it('should broadcast state changes to other instances', async () => {
      const redis2 = new Redis({ host: REDIS_HOST, port: REDIS_PORT, db: 13 })
      const adapter2 = new RedisRoomAdapter({ redis: redis2, prefix: 'test:room:' })

      const received: any[] = []
      await adapter2.subscribe('room-1', (event, data) => {
        received.push({ event, data })
      })

      await wait(100)

      await adapter.publishStateChange('room-1', { count: 10 })
      await wait(200)

      expect(received.length).toBe(1)
      expect(received[0].event).toBe('$state:update')
      expect(received[0].data.state).toEqual({ count: 10 })

      await adapter2.shutdown()
      redis2.disconnect()
    })
  })

  // ── Shutdown ──────────────────────────────────────

  describe('shutdown', () => {
    it('should clean up subscriptions on shutdown', async () => {
      await adapter.subscribe('room-1', () => {})
      await adapter.subscribe('room-2', () => {})

      await adapter.shutdown()
      // No error = success
    })
  })
})
