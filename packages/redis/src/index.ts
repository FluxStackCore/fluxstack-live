// @fluxstack/live-redis - Redis Adapter for FluxStack Live
//
// Provides cross-instance room pub/sub and state persistence via Redis.
// Use this package when you need horizontal scaling (multiple server instances).
//
// Usage:
//   import Redis from 'ioredis'
//   import { RedisRoomAdapter } from '@fluxstack/live-redis'
//   import { LiveServer } from '@fluxstack/live'
//
//   const redis = new Redis(process.env.REDIS_URL)
//   const adapter = new RedisRoomAdapter({ redis })
//
//   const server = new LiveServer({
//     transport: myTransport,
//     roomPubSub: adapter,
//   })

export { RedisRoomAdapter, type RedisRoomAdapterOptions } from './RedisRoomAdapter'
export { RedisClusterAdapter, type RedisClusterAdapterOptions } from './RedisClusterAdapter'
