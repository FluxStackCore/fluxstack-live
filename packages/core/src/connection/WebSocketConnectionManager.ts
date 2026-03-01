// @fluxstack/live - WebSocket Connection Manager
//
// Advanced connection management with pooling, load balancing, and health monitoring.

import { EventEmitter } from 'events'
import type { GenericWebSocket } from '../transport/types'
import { liveLog, liveWarn } from '../debug/LiveLogger'

export interface ConnectionConfig {
  maxConnections: number
  connectionTimeout: number
  heartbeatInterval: number
  reconnectAttempts: number
  reconnectDelay: number
  maxReconnectDelay: number
  jitterFactor: number
  loadBalancing: 'round-robin' | 'least-connections' | 'random'
  healthCheckInterval: number
  messageQueueSize: number
  offlineQueueEnabled: boolean
}

export interface ConnectionMetrics {
  id: string
  connectedAt: Date
  lastActivity: Date
  messagesSent: number
  messagesReceived: number
  bytesTransferred: number
  latency: number
  status: 'connecting' | 'connected' | 'disconnecting' | 'disconnected' | 'error'
  errorCount: number
  reconnectCount: number
}

export interface ConnectionHealth {
  id: string
  status: 'healthy' | 'degraded' | 'unhealthy'
  lastCheck: Date
  issues: string[]
  metrics: ConnectionMetrics
}

export interface QueuedMessage {
  id: string
  message: any
  timestamp: number
  priority: number
  retryCount: number
  maxRetries: number
}

export class WebSocketConnectionManager extends EventEmitter {
  private connections = new Map<string, GenericWebSocket>()
  private connectionMetrics = new Map<string, ConnectionMetrics>()
  private connectionPools = new Map<string, Set<string>>()
  private messageQueues = new Map<string, QueuedMessage[]>()
  private healthCheckTimer?: ReturnType<typeof setInterval>
  private heartbeatTimer?: ReturnType<typeof setInterval>
  private config: ConnectionConfig
  private loadBalancerIndex = 0

  constructor(config?: Partial<ConnectionConfig>) {
    super()
    this.config = {
      maxConnections: 10000,
      connectionTimeout: 30000,
      heartbeatInterval: 30000,
      reconnectAttempts: 5,
      reconnectDelay: 1000,
      maxReconnectDelay: 30000,
      jitterFactor: 0.1,
      loadBalancing: 'round-robin',
      healthCheckInterval: 60000,
      messageQueueSize: 1000,
      offlineQueueEnabled: true,
      ...config
    }

    this.setupHealthMonitoring()
    this.setupHeartbeat()
  }

  registerConnection(ws: GenericWebSocket, connectionId: string, poolId?: string): void {
    if (this.connections.size >= this.config.maxConnections) {
      throw new Error('Maximum connections exceeded')
    }

    const metrics: ConnectionMetrics = {
      id: connectionId,
      connectedAt: new Date(),
      lastActivity: new Date(),
      messagesSent: 0,
      messagesReceived: 0,
      bytesTransferred: 0,
      latency: 0,
      status: 'connected',
      errorCount: 0,
      reconnectCount: 0
    }

    this.connections.set(connectionId, ws)
    this.connectionMetrics.set(connectionId, metrics)

    if (poolId) {
      this.addToPool(connectionId, poolId)
    }

    this.messageQueues.set(connectionId, [])
    liveLog('websocket', null, `Connection registered: ${connectionId}`)
    this.emit('connectionRegistered', { connectionId, poolId })
  }

  addToPool(connectionId: string, poolId: string): void {
    if (!this.connectionPools.has(poolId)) {
      this.connectionPools.set(poolId, new Set())
    }
    this.connectionPools.get(poolId)!.add(connectionId)
  }

  removeFromPool(connectionId: string, poolId: string): void {
    const pool = this.connectionPools.get(poolId)
    if (pool) {
      pool.delete(connectionId)
      if (pool.size === 0) this.connectionPools.delete(poolId)
    }
  }

  cleanupConnection(connectionId: string): void {
    this.connections.delete(connectionId)
    this.connectionMetrics.delete(connectionId)
    this.messageQueues.delete(connectionId)

    for (const [poolId, pool] of this.connectionPools) {
      if (pool.has(connectionId)) {
        this.removeFromPool(connectionId, poolId)
      }
    }
  }

  getConnectionMetrics(connectionId: string): ConnectionMetrics | null {
    return this.connectionMetrics.get(connectionId) || null
  }

  getAllConnectionMetrics(): ConnectionMetrics[] {
    return Array.from(this.connectionMetrics.values())
  }

  getSystemStats() {
    const totalConnections = this.connections.size
    const activeConnections = Array.from(this.connections.values()).filter(ws => ws.readyState === 1).length
    const totalPools = this.connectionPools.size
    const totalQueuedMessages = Array.from(this.messageQueues.values()).reduce((sum, queue) => sum + queue.length, 0)

    return {
      totalConnections,
      activeConnections,
      totalPools,
      totalQueuedMessages,
      maxConnections: this.config.maxConnections,
      connectionUtilization: (totalConnections / this.config.maxConnections) * 100
    }
  }

  private setupHealthMonitoring(): void {
    this.healthCheckTimer = setInterval(() => this.performHealthChecks(), this.config.healthCheckInterval)
  }

  private setupHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const [connectionId, ws] of this.connections) {
        if (ws.readyState === 1) {
          try {
            const wsAny = ws as any
            if (typeof wsAny.ping === 'function') {
              wsAny._pingTime = Date.now()
              wsAny.ping()
            }
          } catch {
            // Ignore heartbeat failures
          }
        }
      }
    }, this.config.heartbeatInterval)
  }

  private async performHealthChecks(): Promise<void> {
    const now = Date.now()
    const unhealthy: string[] = []

    for (const [connectionId, metrics] of this.connectionMetrics) {
      const ws = this.connections.get(connectionId)
      if (!ws || ws.readyState !== 1) {
        unhealthy.push(connectionId)
        continue
      }

      const timeSinceActivity = now - metrics.lastActivity.getTime()
      if (timeSinceActivity > this.config.heartbeatInterval * 2) {
        metrics.status = 'disconnected'
      }
      if (metrics.errorCount > 10) {
        unhealthy.push(connectionId)
      }
    }

    for (const connectionId of unhealthy) {
      const ws = this.connections.get(connectionId)
      if (ws) {
        try { ws.close() } catch { /* ignore */ }
      }
      this.cleanupConnection(connectionId)
    }
  }

  shutdown(): void {
    if (this.healthCheckTimer) clearInterval(this.healthCheckTimer)
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)

    for (const [, ws] of this.connections) {
      try { ws.close() } catch { /* ignore */ }
    }

    this.connections.clear()
    this.connectionMetrics.clear()
    this.connectionPools.clear()
    this.messageQueues.clear()
  }
}
