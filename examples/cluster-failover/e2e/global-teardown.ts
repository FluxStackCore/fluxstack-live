import { createRedisClient, flushClusterKeys } from './helpers/redis'

export default async function globalTeardown() {
  const redis = createRedisClient()
  await flushClusterKeys(redis)
  redis.disconnect()
}
