// Verify: JSON.parse with try-catch in Redis adapters
// Before fix: corrupted data in Redis would crash the server
// After fix: returns null gracefully
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Redis from 'ioredis'
import { RedisClusterAdapter } from '../RedisClusterAdapter'

const REDIS_HOST = '127.0.0.1'
const REDIS_PORT = 16379

describe('RedisClusterAdapter — corrupted data handling', () => {
  let redis: Redis
  let subscriber: Redis
  let adapter: RedisClusterAdapter

  beforeAll(async () => {
    try {
      redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT, lazyConnect: true })
      await redis.connect()
      const test = new Redis({ host: REDIS_HOST, port: REDIS_PORT, lazyConnect: true })
      await test.connect()
      await test.disconnect()
    } catch {
      throw new Error(
        `Redis not available at ${REDIS_HOST}:${REDIS_PORT}. ` +
        `Run: docker run -d --name fluxstack-test-redis -p ${REDIS_PORT}:6379 redis:7-alpine`
      )
    }

    subscriber = redis.duplicate()
    adapter = new RedisClusterAdapter({ redis, subscriber })
    await adapter.start()
  })

  afterAll(async () => {
    await adapter.shutdown()
    await redis.quit()
    await subscriber.quit()
  })

  it('loadState should return null for corrupted JSON instead of throwing', async () => {
    const componentId = 'test-corrupt-component'
    // Must match the adapter's internal key format: prefix + 'state:' + componentId
    const key = `fluxstack:cluster:state:${componentId}`

    // Inject corrupted JSON directly into Redis
    await redis.set(key, '{invalid json!!!}')

    // Before fix: JSON.parse throws SyntaxError (crashes the caller)
    // After fix: returns null gracefully
    let result: any
    let threw = false
    try {
      result = await adapter.loadState(componentId)
    } catch {
      threw = true
    }

    // Should NOT throw
    expect(threw).toBe(false)
    // Should return null
    expect(result).toBeNull()

    // Cleanup
    await redis.del(key)
  })

  it('loadState should work normally with valid JSON', async () => {
    const componentId = 'test-valid-component'

    await adapter.saveState(componentId, 'TestComponent', { count: 42 })
    const result = await adapter.loadState(componentId)

    expect(result).toBeTruthy()
    expect(result!.state).toEqual({ count: 42 })

    // Cleanup
    await adapter.deleteState(componentId)
  })

  it('loadSingletonState should return null for corrupted JSON', async () => {
    const key = 'fluxstack:cluster:singleton-state:CorruptSingleton'

    await redis.set(key, 'not-json-at-all')

    const result = await adapter.loadSingletonState('CorruptSingleton')
    expect(result).toBeNull()

    await redis.del(key)
  })
})
