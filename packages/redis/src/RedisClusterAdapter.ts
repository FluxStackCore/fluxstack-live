// @fluxstack/live-redis - Redis Cluster Adapter
//
// Implements IClusterAdapter for cross-instance component synchronization.
// Uses ioredis for Redis pub/sub, state mirroring, and singleton coordination.
//
// Usage:
//   import Redis from 'ioredis'
//   import { RedisClusterAdapter } from '@fluxstack/live-redis'
//   import { LiveServer } from '@fluxstack/live'
//
//   const redis = new Redis()
//   const cluster = new RedisClusterAdapter({ redis })
//
//   const server = new LiveServer({
//     transport: myTransport,
//     cluster,
//   })

import type {
  IClusterAdapter,
  ClusterComponentState,
  ClusterSingletonOwner,
  ClusterSingletonClaim,
  ClusterActionRequest,
  ClusterActionResponse,
  ClusterDeltaHandler,
} from '@fluxstack/live'
import type Redis from 'ioredis'

export interface RedisClusterAdapterOptions {
  /** ioredis client instance for commands (publish, get, set, etc.) */
  redis: Redis
  /** Optional separate ioredis client for subscriptions.
   *  If not provided, a duplicate of `redis` will be created.
   *  ioredis requires separate connections for subscribe mode. */
  subscriber?: Redis
  /** Key prefix for all Redis keys. Defaults to 'fluxstack:cluster:' */
  prefix?: string
  /** Component state TTL in seconds. Defaults to 3600 (1h).
   *  Set to 0 to disable expiration. */
  stateTtl?: number
  /** Singleton claim TTL in seconds. Defaults to 30.
   *  Must be greater than heartbeat interval. */
  singletonTtl?: number
  /** Heartbeat interval in ms for renewing singleton claims. Defaults to 10000 (10s). */
  heartbeatInterval?: number
  /** Action forwarding timeout in ms. Defaults to 5000 (5s). */
  actionTimeout?: number
}

/** Internal message types for pub/sub channels */
interface ClusterMessage {
  type: 'delta' | 'action_request' | 'action_response'
  origin: string
  // delta fields
  componentId?: string
  componentName?: string
  delta?: any
  // action fields
  request?: ClusterActionRequest
  response?: ClusterActionResponse
}

interface PendingAction {
  resolve: (value: ClusterActionResponse) => void
  reject: (reason: any) => void
  timeout: ReturnType<typeof setTimeout>
}

export class RedisClusterAdapter implements IClusterAdapter {
  public readonly instanceId: string

  private redis: Redis
  private subscriber: Redis
  private prefix: string
  private stateTtl: number
  private singletonTtl: number
  private heartbeatMs: number
  private actionTimeoutMs: number

  private ownedSingletons = new Map<string, string>() // componentName → componentId
  private pendingActions = new Map<string, PendingAction>() // requestId → PendingAction
  private deltaHandler: ClusterDeltaHandler | null = null
  private actionHandler: ((req: ClusterActionRequest) => Promise<ClusterActionResponse>) | null = null
  private ownershipLostHandler: ((componentName: string) => void) | null = null
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null
  private started = false

  constructor(options: RedisClusterAdapterOptions) {
    this.redis = options.redis
    this.subscriber = options.subscriber ?? options.redis.duplicate()
    this.prefix = options.prefix ?? 'fluxstack:cluster:'
    this.stateTtl = options.stateTtl ?? 3600
    this.singletonTtl = options.singletonTtl ?? 30
    this.heartbeatMs = options.heartbeatInterval ?? 10_000
    this.actionTimeoutMs = options.actionTimeout ?? 5_000
    this.instanceId = `inst-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }

  // ── Redis Key Helpers ────────────────────────────────

  private stateKey(componentId: string): string {
    return `${this.prefix}state:${componentId}`
  }

  private singletonKey(componentName: string): string {
    return `${this.prefix}singleton:${componentName}`
  }

  private singletonStateKey(componentName: string): string {
    return `${this.prefix}singleton-state:${componentName}`
  }

  private deltaChannel(): string {
    return `${this.prefix}delta`
  }

  private actionsChannel(instanceId: string): string {
    return `${this.prefix}actions:${instanceId}`
  }

  // ── State Mirror ─────────────────────────────────────

  async saveState(componentId: string, componentName: string, state: any): Promise<void> {
    const data: ClusterComponentState = {
      componentName,
      state,
      instanceId: this.instanceId,
      updatedAt: Date.now(),
    }
    const key = this.stateKey(componentId)
    if (this.stateTtl > 0) {
      await this.redis.set(key, JSON.stringify(data), 'EX', this.stateTtl)
    } else {
      await this.redis.set(key, JSON.stringify(data))
    }
  }

  async loadState(componentId: string): Promise<ClusterComponentState | null> {
    const raw = await this.redis.get(this.stateKey(componentId))
    return raw ? JSON.parse(raw) : null
  }

  async deleteState(componentId: string): Promise<void> {
    await this.redis.del(this.stateKey(componentId))
  }

  // ── State Delta Pub/Sub ──────────────────────────────

  async publishDelta(componentId: string, componentName: string, delta: any): Promise<void> {
    const msg: ClusterMessage = {
      type: 'delta',
      origin: this.instanceId,
      componentId,
      componentName,
      delta,
    }
    await this.redis.publish(this.deltaChannel(), JSON.stringify(msg))
  }

  onDelta(handler: ClusterDeltaHandler): void {
    this.deltaHandler = handler
  }

  // ── Singleton Coordination ───────────────────────────

  async claimSingleton(componentName: string, componentId: string): Promise<ClusterSingletonClaim> {
    const key = this.singletonKey(componentName)
    const value = `${this.instanceId}:${componentId}`
    // SET NX = atomic set-if-not-exists, EX = TTL in seconds
    const result = await this.redis.set(key, value, 'EX', this.singletonTtl, 'NX')
    if (result === 'OK') {
      this.ownedSingletons.set(componentName, componentId)
      // Failover recovery: load previous singleton state (survives owner crash + claim expiry)
      const recoveredState = await this.loadSingletonState(componentName)
      return { claimed: true, recoveredState: recoveredState ?? undefined }
    }
    return { claimed: false }
  }

  async getSingletonOwner(componentName: string): Promise<ClusterSingletonOwner | null> {
    const raw = await this.redis.get(this.singletonKey(componentName))
    if (!raw) return null
    const [instanceId, componentId] = raw.split(':')
    if (!instanceId || !componentId) return null
    return { instanceId, componentId }
  }

  async releaseSingleton(componentName: string): Promise<void> {
    this.ownedSingletons.delete(componentName)
    await this.redis.del(this.singletonKey(componentName))
  }

  async verifySingletonOwnership(componentName: string): Promise<boolean> {
    const raw = await this.redis.get(this.singletonKey(componentName))
    if (!raw) return false
    // Claim value format: "instanceId:componentId"
    return raw.startsWith(this.instanceId + ':')
  }

  onOwnershipLost(handler: (componentName: string) => void): void {
    this.ownershipLostHandler = handler
  }

  async saveSingletonState(componentName: string, state: any): Promise<void> {
    const key = this.singletonStateKey(componentName)
    const data = JSON.stringify({ state, updatedAt: Date.now() })
    if (this.stateTtl > 0) {
      await this.redis.set(key, data, 'EX', this.stateTtl)
    } else {
      await this.redis.set(key, data)
    }
  }

  async loadSingletonState(componentName: string): Promise<any | null> {
    const raw = await this.redis.get(this.singletonStateKey(componentName))
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw)
      return parsed.state ?? null
    } catch {
      return null
    }
  }

  // ── Action Forwarding ────────────────────────────────

  async forwardAction(request: ClusterActionRequest): Promise<ClusterActionResponse> {
    return new Promise<ClusterActionResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingActions.delete(request.requestId)
        reject(new Error(`Cluster action timeout after ${this.actionTimeoutMs}ms`))
      }, this.actionTimeoutMs)

      this.pendingActions.set(request.requestId, { resolve, reject, timeout })

      const msg: ClusterMessage = {
        type: 'action_request',
        origin: this.instanceId,
        request,
      }
      this.redis.publish(
        this.actionsChannel(request.targetInstanceId),
        JSON.stringify(msg)
      ).catch((err) => {
        this.pendingActions.delete(request.requestId)
        clearTimeout(timeout)
        reject(err)
      })
    })
  }

  onActionForward(handler: (req: ClusterActionRequest) => Promise<ClusterActionResponse>): void {
    this.actionHandler = handler
  }

  // ── Lifecycle ────────────────────────────────────────

  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    // Subscribe to delta channel (global)
    await this.subscriber.subscribe(this.deltaChannel())

    // Subscribe to this instance's action channel
    await this.subscriber.subscribe(this.actionsChannel(this.instanceId))

    // Handle incoming messages
    this.subscriber.on('message', (channel: string, raw: string) => {
      try {
        const msg: ClusterMessage = JSON.parse(raw)

        // Skip own messages (echo prevention)
        if (msg.origin === this.instanceId) return

        switch (msg.type) {
          case 'delta':
            this.handleDelta(msg)
            break
          case 'action_request':
            this.handleActionRequest(msg)
            break
          case 'action_response':
            this.handleActionResponse(msg)
            break
        }
      } catch {
        // Silently ignore malformed messages
      }
    })

    // Start heartbeat for singleton claims
    this.heartbeatInterval = setInterval(() => this.renewSingletonClaims(), this.heartbeatMs)
  }

  async shutdown(): Promise<void> {
    // Stop heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }

    // Release all singleton claims
    for (const [name] of this.ownedSingletons) {
      await this.redis.del(this.singletonKey(name)).catch(() => {})
    }
    this.ownedSingletons.clear()

    // Reject all pending actions
    for (const [, pending] of this.pendingActions) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Cluster adapter shutting down'))
    }
    this.pendingActions.clear()

    // Unsubscribe
    await this.subscriber.unsubscribe(
      this.deltaChannel(),
      this.actionsChannel(this.instanceId)
    ).catch(() => {})

    this.subscriber.disconnect()
    this.started = false
  }

  // ── Internal Handlers ────────────────────────────────

  private handleDelta(msg: ClusterMessage): void {
    if (!this.deltaHandler || !msg.componentId || !msg.componentName) return
    this.deltaHandler(msg.componentId, msg.componentName, msg.delta, msg.origin)
  }

  private async handleActionRequest(msg: ClusterMessage): Promise<void> {
    if (!this.actionHandler || !msg.request) return

    try {
      const response = await this.actionHandler(msg.request)

      // Send response back to the source instance
      const reply: ClusterMessage = {
        type: 'action_response',
        origin: this.instanceId,
        response: { ...response, requestId: msg.request.requestId },
      }
      await this.redis.publish(
        this.actionsChannel(msg.request.sourceInstanceId),
        JSON.stringify(reply)
      )
    } catch (error: any) {
      // Send error response
      const reply: ClusterMessage = {
        type: 'action_response',
        origin: this.instanceId,
        response: {
          success: false,
          error: error.message,
          requestId: msg.request.requestId,
        },
      }
      await this.redis.publish(
        this.actionsChannel(msg.request.sourceInstanceId),
        JSON.stringify(reply)
      ).catch(() => {})
    }
  }

  private handleActionResponse(msg: ClusterMessage): void {
    if (!msg.response?.requestId) return
    const pending = this.pendingActions.get(msg.response.requestId)
    if (!pending) return

    clearTimeout(pending.timeout)
    this.pendingActions.delete(msg.response.requestId)
    pending.resolve(msg.response)
  }

  private async renewSingletonClaims(): Promise<void> {
    for (const [name, componentId] of this.ownedSingletons) {
      try {
        // Verify we still own before renewing (split-brain protection)
        const raw = await this.redis.get(this.singletonKey(name))
        const expectedValue = `${this.instanceId}:${componentId}`

        if (raw === null) {
          // Claim expired or was deleted — try to re-claim
          const reclaimed = await this.redis.set(
            this.singletonKey(name), expectedValue,
            'EX', this.singletonTtl, 'NX'
          )
          if (reclaimed !== 'OK') {
            // Another instance claimed it — we lost ownership
            this.ownedSingletons.delete(name)
            this.ownershipLostHandler?.(name)
          }
        } else if (raw === expectedValue) {
          // Still ours — renew TTL
          await this.redis.expire(this.singletonKey(name), this.singletonTtl)
        } else {
          // Someone else owns it — we lost ownership (split-brain detected)
          this.ownedSingletons.delete(name)
          this.ownershipLostHandler?.(name)
        }
      } catch {
        // If renewal fails, the claim will naturally expire
      }
    }
  }
}
