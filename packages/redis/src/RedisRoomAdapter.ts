// @fluxstack/live-redis - Redis Room Adapter
//
// Implements IRoomPubSubAdapter for cross-instance room event propagation.
// Uses ioredis for Redis pub/sub and state storage.
//
// Usage:
//   import Redis from 'ioredis'
//   import { RedisRoomAdapter } from '@fluxstack/live-redis'
//
//   const redis = new Redis()
//   const adapter = new RedisRoomAdapter({ redis })
//   const server = new LiveServer({ transport, roomPubSub: adapter })

import type { IRoomPubSubAdapter } from '@fluxstack/live'
import { generateId } from '@fluxstack/live'
import type Redis from 'ioredis'

/**
 * Atomic GET + shallow-merge + SET for room state.
 * KEYS[1] = state key, ARGV[1] = JSON of fields to merge, ARGV[2] = TTL secs (0 = none).
 * Runs entirely server-side so concurrent writers can't lose each other's fields.
 * A corrupted/non-JSON existing value is treated as empty (start fresh), matching
 * the previous behaviour.
 */
const MERGE_STATE_LUA = `
local cur = redis.call('GET', KEYS[1])
local state = {}
if cur then
  local ok, decoded = pcall(cjson.decode, cur)
  if ok and type(decoded) == 'table' then state = decoded end
end
local updates = cjson.decode(ARGV[1])
for k, v in pairs(updates) do state[k] = v end
local encoded = cjson.encode(state)
-- cjson encodes an empty table as '{}' (object), which is what we want for state.
local ttl = tonumber(ARGV[2])
if ttl and ttl > 0 then
  redis.call('SET', KEYS[1], encoded, 'EX', ttl)
else
  redis.call('SET', KEYS[1], encoded)
end
return encoded
`

export interface RedisRoomAdapterOptions {
  /** ioredis client instance for commands (publish, get, set, etc.) */
  redis: Redis
  /** Optional separate ioredis client for subscriptions.
   *  If not provided, a duplicate of `redis` will be created.
   *  ioredis requires separate connections for subscribe mode. */
  subscriber?: Redis
  /** Key prefix for all Redis keys. Defaults to 'fluxstack:room:' */
  prefix?: string
  /** Room state TTL in seconds. Defaults to 86400 (24h).
   *  Set to 0 to disable expiration. */
  stateTtl?: number
}

interface PubSubMessage {
  type: 'event' | 'state' | 'membership'
  roomId: string
  event?: string
  data?: any
  action?: 'join' | 'leave'
  componentId?: string
  updates?: any
  /** Instance ID to prevent echo (processing own messages) */
  origin: string
}

export class RedisRoomAdapter implements IRoomPubSubAdapter {
  private redis: Redis
  private subscriber: Redis
  private prefix: string
  private stateTtl: number
  private instanceId: string
  private handlers = new Map<string, Set<(event: string, data: any) => void>>()
  private subscribed = new Set<string>()
  private started = false

  constructor(options: RedisRoomAdapterOptions) {
    this.redis = options.redis
    this.subscriber = options.subscriber ?? options.redis.duplicate()
    this.prefix = options.prefix ?? 'fluxstack:room:'
    this.stateTtl = options.stateTtl ?? 86400
    this.instanceId = generateId()

    this.setupSubscriber()
  }

  private setupSubscriber(): void {
    if (this.started) return
    this.started = true

    // Handle incoming pub/sub messages
    this.subscriber.on('message', (channel: string, raw: string) => {
      try {
        const msg: PubSubMessage = JSON.parse(raw)

        // Skip messages from this instance (prevent echo)
        if (msg.origin === this.instanceId) return

        const roomId = msg.roomId
        const roomHandlers = this.handlers.get(roomId)
        if (!roomHandlers || roomHandlers.size === 0) return

        switch (msg.type) {
          case 'event':
            for (const handler of roomHandlers) {
              handler(msg.event!, msg.data)
            }
            break
          case 'state':
            for (const handler of roomHandlers) {
              handler('$state:update', { state: msg.updates })
            }
            break
          case 'membership':
            for (const handler of roomHandlers) {
              handler(`$sub:${msg.action}`, {
                subscriberId: msg.componentId,
              })
            }
            break
        }
      } catch {
        // Silently ignore malformed messages
      }
    })
  }

  /**
   * Get the Redis channel name for a room.
   */
  private channel(roomId: string): string {
    return `${this.prefix}ch:${roomId}`
  }

  /**
   * Get the Redis key for room state.
   */
  private stateKey(roomId: string): string {
    return `${this.prefix}state:${roomId}`
  }

  // ===== IRoomPubSubAdapter =====

  async publish(roomId: string, event: string, data: any): Promise<void> {
    const msg: PubSubMessage = {
      type: 'event',
      roomId,
      event,
      data,
      origin: this.instanceId,
    }
    await this.redis.publish(this.channel(roomId), JSON.stringify(msg))
  }

  async subscribe(roomId: string, handler: (event: string, data: any) => void): Promise<() => void> {
    // Track handler
    let roomHandlers = this.handlers.get(roomId)
    if (!roomHandlers) {
      roomHandlers = new Set()
      this.handlers.set(roomId, roomHandlers)
    }
    roomHandlers.add(handler)

    // Subscribe to Redis channel if first handler for this room
    const ch = this.channel(roomId)
    if (!this.subscribed.has(ch)) {
      this.subscribed.add(ch)
      await this.subscriber.subscribe(ch)
    }

    // Return unsubscribe function
    return () => {
      roomHandlers!.delete(handler)
      if (roomHandlers!.size === 0) {
        this.handlers.delete(roomId)
        this.subscribed.delete(ch)
        this.subscriber.unsubscribe(ch).catch(() => {})
      }
    }
  }

  async publishMembership(roomId: string, action: 'join' | 'leave', componentId: string): Promise<void> {
    const msg: PubSubMessage = {
      type: 'membership',
      roomId,
      action,
      componentId,
      origin: this.instanceId,
    }
    await this.redis.publish(this.channel(roomId), JSON.stringify(msg))
  }

  async publishStateChange(roomId: string, updates: any): Promise<void> {
    // 1. Persist state update to Redis (for new instances joining later).
    //    Done atomically via a Lua script: the GET, shallow-merge and SET run
    //    server-side as one unit, so concurrent writes from other instances can
    //    no longer clobber each other (specs/05 FP-1). Previously this was a
    //    GET + Object.assign + SET round-trip with a lost-update race window.
    const key = this.stateKey(roomId)
    await this.redis.eval(
      MERGE_STATE_LUA,
      1,            // numKeys
      key,          // KEYS[1]
      JSON.stringify(updates), // ARGV[1] — fields to merge
      String(this.stateTtl > 0 ? this.stateTtl : 0), // ARGV[2] — TTL (0 = no expiry)
    )

    // 2. Publish change to other instances
    const msg: PubSubMessage = {
      type: 'state',
      roomId,
      updates,
      origin: this.instanceId,
    }
    await this.redis.publish(this.channel(roomId), JSON.stringify(msg))
  }

  // ===== Additional Utilities =====

  /**
   * Get persisted room state from Redis.
   * Useful for loading state when a new instance joins an existing room.
   */
  async getPersistedState<T = any>(roomId: string): Promise<T | null> {
    const raw = await this.redis.get(this.stateKey(roomId))
    if (!raw) return null
    try { return JSON.parse(raw) } catch { return null }
  }

  /**
   * Delete persisted room state from Redis.
   */
  async deletePersistedState(roomId: string): Promise<boolean> {
    const result = await this.redis.del(this.stateKey(roomId))
    return result > 0
  }

  /**
   * Graceful shutdown: unsubscribe from all channels and disconnect subscriber.
   */
  async shutdown(): Promise<void> {
    if (this.subscribed.size > 0) {
      await this.subscriber.unsubscribe(...this.subscribed).catch(() => {})
    }
    this.handlers.clear()
    this.subscribed.clear()
    this.subscriber.disconnect()
  }
}
