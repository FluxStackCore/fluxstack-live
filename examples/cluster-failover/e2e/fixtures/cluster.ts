import { test as base } from '@playwright/test'
import Redis from 'ioredis'
import { flushClusterKeys } from '../helpers/redis'

export const test = base.extend<{ cleanRedis: void }>({
  cleanRedis: [async ({}, use) => {
    const redis = new Redis({ host: '127.0.0.1', port: 16379 })
    await flushClusterKeys(redis)
    await use()
    await flushClusterKeys(redis)
    redis.disconnect()
  }, { auto: true }],
})

export { expect } from '@playwright/test'
