import { existsSync } from 'fs'
import path from 'path'
import { pingRedis, createRedisClient, flushClusterKeys } from './helpers/redis'

export default async function globalSetup() {
  // 1. Verify Redis
  const redisOk = await pingRedis()
  if (!redisOk) {
    throw new Error(
      'Redis not available at 127.0.0.1:16379.\n' +
      'Run: docker run -d --name fluxstack-test-redis -p 16379:6379 redis:7-alpine'
    )
  }

  // 2. Verify client bundle
  const bundlePath = path.resolve(__dirname, '../../../packages/client/dist/live-client.browser.global.js')
  if (!existsSync(bundlePath)) {
    throw new Error(
      'Client bundle not found.\n' +
      'Run: cd fluxstack-live && bun run build:client'
    )
  }

  // 3. Flush Redis keys for clean start
  const redis = createRedisClient()
  await flushClusterKeys(redis)
  redis.disconnect()
}
