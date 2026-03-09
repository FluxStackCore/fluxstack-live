import Redis from 'ioredis'

const REDIS_HOST = '127.0.0.1'
const REDIS_PORT = 16379
const KEY_PREFIX = 'demo:cluster:'

export function createRedisClient(): Redis {
  return new Redis({ host: REDIS_HOST, port: REDIS_PORT })
}

export async function flushClusterKeys(redis: Redis): Promise<number> {
  const keys = await redis.keys(`${KEY_PREFIX}*`)
  if (keys.length > 0) {
    await redis.del(...keys)
  }
  return keys.length
}

export async function getSingletonState(redis: Redis, name: string): Promise<any | null> {
  const raw = await redis.get(`${KEY_PREFIX}singleton-state:${name}`)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed.state ?? null
  } catch {
    return null
  }
}

export async function pingRedis(): Promise<boolean> {
  const redis = createRedisClient()
  try {
    const result = await redis.ping()
    redis.disconnect()
    return result === 'PONG'
  } catch {
    redis.disconnect()
    return false
  }
}
