// Verify: JSON.parse with try-catch in Redis adapters
// Before fix: corrupted data in Redis would crash with SyntaxError
// After fix: returns null gracefully
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import Redis from 'ioredis'
import { RedisClusterAdapter } from '../RedisClusterAdapter'

const REDIS_HOST = '127.0.0.1'
const REDIS_PORT = 16379
const TEST_PREFIX = 'test:corrupt:'

describe('RedisClusterAdapter — corrupted data handling', () => {
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
    redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT, db: 15 })
    await redis.flushdb()
    adapter = new RedisClusterAdapter({
      redis,
      prefix: TEST_PREFIX,
      stateTtl: 60,
      singletonTtl: 10,
      heartbeatInterval: 60_000,
    })
    await adapter.start()
  })

  afterEach(async () => {
    await adapter.shutdown()
    await redis.quit()
  })

  it('loadState should return null for corrupted JSON instead of throwing', async () => {
    const componentId = 'corrupt-comp'

    // First save valid state so we know the key format works
    await adapter.saveState(componentId, 'TestComp', { count: 1 })
    const valid = await adapter.loadState(componentId)
    expect(valid).toBeTruthy()

    // Now overwrite with corrupted JSON using the same key pattern
    // The adapter uses: prefix + 'state:' + componentId
    await redis.set(`${TEST_PREFIX}state:${componentId}`, '{invalid json!!!}')

    // Before fix: JSON.parse throws SyntaxError (crashes the caller)
    // After fix: returns null gracefully
    let result: any
    let threw = false
    try {
      result = await adapter.loadState(componentId)
    } catch {
      threw = true
    }

    expect(threw).toBe(false)
    expect(result).toBeNull()
  })

  it('loadState should work normally with valid JSON', async () => {
    await adapter.saveState('valid-comp', 'TestComp', { count: 42 })
    const result = await adapter.loadState('valid-comp')
    expect(result).toBeTruthy()
    expect(result!.state).toEqual({ count: 42 })
  })

  it('loadSingletonState should return null for corrupted JSON', async () => {
    // Save valid first to confirm key pattern
    await adapter.saveSingletonState('TestSingleton', { value: 1 })
    const valid = await adapter.loadSingletonState('TestSingleton')
    expect(valid).toBeTruthy()

    // Overwrite with corrupted data
    await redis.set(`${TEST_PREFIX}singleton-state:TestSingleton`, 'not-json')

    const result = await adapter.loadSingletonState('TestSingleton')
    expect(result).toBeNull()
  })
})
