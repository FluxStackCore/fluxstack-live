// @fluxstack/live - LiveServer Orchestrator
//
// Main entry point: wire up transport, create singletons, expose public API.
// Usage:
//   const server = new LiveServer({ transport: new ElysiaTransport(app) })
//   await server.start()

import type { LiveTransport, GenericWebSocket, WebSocketConfig, HttpRouteDefinition } from '../transport/types'
import type { LiveMessage, WebSocketResponse } from '../protocol/messages'
import { RoomEventBus } from '../rooms/RoomEventBus'
import { LiveRoomManager } from '../rooms/LiveRoomManager'
import { LiveDebugger } from '../debug/LiveDebugger'
import { LiveAuthManager } from '../auth/LiveAuthManager'
import { StateSignatureManager, type StateSignatureConfig } from '../security/StateSignature'
import { PerformanceMonitor, type PerformanceConfig } from '../monitoring/PerformanceMonitor'
import { FileUploadManager, type FileUploadConfig } from '../upload/FileUploadManager'
import { WebSocketConnectionManager, type ConnectionConfig } from '../connection/WebSocketConnectionManager'
import { ComponentRegistry } from '../component/ComponentRegistry'
import { setLiveComponentContext } from '../component/context'
import { RateLimiterRegistry } from '../connection/RateLimiter'
import { liveLog, _setLoggerDebugger } from '../debug/LiveLogger'
import { decodeBinaryChunk } from '../protocol/binary'
import { DEFAULT_WS_PATH } from '../protocol/constants'
import type { LiveAuthProvider } from '../auth/types'

export interface LiveServerOptions {
  /** Transport adapter (Elysia, Express, etc.) */
  transport: LiveTransport
  /** WebSocket endpoint path. Defaults to '/api/live/ws' */
  wsPath?: string
  /** Enable debug mode. Defaults to false. */
  debug?: boolean
  /** State signature configuration */
  stateSignature?: StateSignatureConfig
  /** Performance monitor configuration */
  performance?: PerformanceConfig
  /** File upload configuration */
  fileUpload?: FileUploadConfig
  /** Connection manager configuration */
  connection?: Partial<ConnectionConfig>
  /** Rate limiter: max tokens per connection */
  rateLimitMaxTokens?: number
  /** Rate limiter: tokens refilled per second */
  rateLimitRefillRate?: number
  /** Components path for auto-discovery */
  componentsPath?: string
  /** HTTP monitoring routes prefix. Set to false to disable. Defaults to '/api/live' */
  httpPrefix?: string | false
}

export class LiveServer {
  // Public singletons (accessible for transport adapters & advanced usage)
  public readonly roomEvents: RoomEventBus
  public readonly roomManager: LiveRoomManager
  public readonly debugger: LiveDebugger
  public readonly authManager: LiveAuthManager
  public readonly stateSignature: StateSignatureManager
  public readonly performanceMonitor: PerformanceMonitor
  public readonly fileUploadManager: FileUploadManager
  public readonly connectionManager: WebSocketConnectionManager
  public readonly registry: ComponentRegistry
  public readonly rateLimiter: RateLimiterRegistry

  private transport: LiveTransport
  private options: LiveServerOptions

  constructor(options: LiveServerOptions) {
    this.options = options
    this.transport = options.transport

    // Create all singletons
    this.roomEvents = new RoomEventBus()
    this.roomManager = new LiveRoomManager(this.roomEvents)
    this.debugger = new LiveDebugger(options.debug ?? false)
    this.authManager = new LiveAuthManager()
    this.stateSignature = new StateSignatureManager(options.stateSignature)
    this.performanceMonitor = new PerformanceMonitor(options.performance)
    this.fileUploadManager = new FileUploadManager(options.fileUpload)
    this.connectionManager = new WebSocketConnectionManager(options.connection)
    this.rateLimiter = new RateLimiterRegistry(options.rateLimitMaxTokens, options.rateLimitRefillRate)

    this.registry = new ComponentRegistry({
      authManager: this.authManager,
      debugger: this.debugger,
      stateSignature: this.stateSignature,
      performanceMonitor: this.performanceMonitor,
    })

    // Wire logger -> debugger
    _setLoggerDebugger(this.debugger)

    // Set global context for LiveComponent base class
    setLiveComponentContext({
      roomEvents: this.roomEvents,
      roomManager: this.roomManager,
      debugger: this.debugger,
    })
  }

  /**
   * Register an auth provider.
   */
  useAuth(provider: LiveAuthProvider): this {
    this.authManager.register(provider)
    return this
  }

  /**
   * Start the LiveServer: register WS + HTTP handlers on the transport.
   */
  async start(): Promise<void> {
    // Auto-discover components if path provided
    if (this.options.componentsPath) {
      await this.registry.autoDiscoverComponents(this.options.componentsPath)
    }

    // Register WebSocket handler
    const wsConfig: WebSocketConfig = {
      path: this.options.wsPath ?? DEFAULT_WS_PATH,
      onOpen: (ws) => this.handleOpen(ws),
      onMessage: (ws, message, isBinary) => this.handleMessage(ws, message, isBinary),
      onClose: (ws, code, reason) => this.handleClose(ws, code, reason),
      onError: (ws, error) => this.handleError(ws, error),
    }
    await this.transport.registerWebSocket(wsConfig)

    // Register HTTP routes
    if (this.options.httpPrefix !== false) {
      const prefix = this.options.httpPrefix ?? '/api/live'
      await this.transport.registerHttpRoutes(this.buildHttpRoutes(prefix))
    }

    // Transport startup hook
    if (this.transport.start) {
      await this.transport.start()
    }

    liveLog('lifecycle', null, `LiveServer started (ws: ${wsConfig.path})`)
  }

  /**
   * Graceful shutdown.
   */
  async shutdown(): Promise<void> {
    this.registry.cleanup()
    this.connectionManager.shutdown()
    this.fileUploadManager.shutdown()
    this.stateSignature.shutdown()
    if (this.transport.shutdown) await this.transport.shutdown()
    liveLog('lifecycle', null, 'LiveServer shut down')
  }

  // ===== WebSocket Handlers =====

  private handleOpen(ws: GenericWebSocket): void {
    const connectionId = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    ws.data = {
      connectionId,
      components: new Map(),
      subscriptions: new Set(),
      connectedAt: new Date(),
    }

    this.connectionManager.registerConnection(ws, connectionId)
    this.debugger.trackConnection(connectionId)

    ws.send(JSON.stringify({
      type: 'CONNECTION_ESTABLISHED',
      connectionId,
      timestamp: Date.now()
    }))

    liveLog('websocket', null, `Connection opened: ${connectionId}`)
  }

  private async handleMessage(ws: GenericWebSocket, rawMessage: unknown, isBinary: boolean): Promise<void> {
    // Rate limit
    const connectionId = ws.data?.connectionId
    if (connectionId) {
      const limiter = this.rateLimiter.get(connectionId)
      if (!limiter.tryConsume()) {
        ws.send(JSON.stringify({ type: 'ERROR', error: 'Rate limit exceeded', timestamp: Date.now() }))
        return
      }
    }

    // Binary protocol (file upload chunks)
    if (isBinary && rawMessage instanceof ArrayBuffer) {
      try {
        const { header, data } = decodeBinaryChunk(rawMessage)
        if (header.type === 'FILE_UPLOAD_CHUNK') {
          const chunkMessage = { ...header, data: '' } as any
          const progress = await this.fileUploadManager.receiveChunk(chunkMessage, data)
          if (progress) ws.send(JSON.stringify(progress))
        }
      } catch (error: any) {
        ws.send(JSON.stringify({ type: 'ERROR', error: error.message, timestamp: Date.now() }))
      }
      return
    }

    // JSON protocol
    let message: LiveMessage
    try {
      const str = typeof rawMessage === 'string' ? rawMessage : new TextDecoder().decode(rawMessage as ArrayBuffer)
      message = JSON.parse(str)
    } catch {
      ws.send(JSON.stringify({ type: 'ERROR', error: 'Invalid JSON', timestamp: Date.now() }))
      return
    }

    try {
      // Auth message
      if (message.type === 'AUTH') {
        const authContext = await this.authManager.authenticate(message.payload || {})
        if (ws.data) ws.data.authContext = authContext
        ws.send(JSON.stringify({
          type: 'AUTH_RESPONSE',
          success: authContext.authenticated,
          payload: authContext.authenticated ? { userId: authContext.user?.id } : { error: 'Authentication failed' },
          timestamp: Date.now()
        }))
        return
      }

      // Room messages
      if (message.type === 'ROOM_JOIN' || message.type === 'ROOM_LEAVE' || message.type === 'ROOM_EMIT' || message.type === 'ROOM_STATE_SET' || message.type === 'ROOM_STATE_GET') {
        await this.handleRoomMessage(ws, message)
        return
      }

      // File upload messages
      if (message.type === 'FILE_UPLOAD_START') {
        const result = await this.fileUploadManager.startUpload(message as any, ws.data?.userId)
        ws.send(JSON.stringify({
          type: 'FILE_UPLOAD_START_RESPONSE',
          componentId: message.componentId,
          uploadId: message.payload?.uploadId,
          success: result.success,
          error: result.error,
          requestId: message.requestId,
          timestamp: Date.now()
        }))
        return
      }

      if (message.type === 'FILE_UPLOAD_CHUNK') {
        const progress = await this.fileUploadManager.receiveChunk(message as any)
        if (progress) ws.send(JSON.stringify(progress))
        return
      }

      if (message.type === 'FILE_UPLOAD_COMPLETE') {
        const result = await this.fileUploadManager.completeUpload(message as any)
        ws.send(JSON.stringify(result))
        return
      }

      // Component rehydration
      if (message.type === 'COMPONENT_REHYDRATE') {
        const result = await this.registry.rehydrateComponent(
          message.componentId,
          message.payload.component,
          message.payload.signedState,
          ws,
          { room: message.payload.room, userId: message.userId }
        )
        ws.send(JSON.stringify({
          type: 'COMPONENT_REHYDRATED',
          componentId: message.componentId,
          success: result.success,
          result: result.success ? { newComponentId: result.newComponentId } : undefined,
          error: result.error,
          requestId: message.requestId,
          timestamp: Date.now()
        }))
        return
      }

      // Delegate to registry
      const result = await this.registry.handleMessage(ws, message)

      if (result !== null) {
        const response: WebSocketResponse = {
          type: message.type === 'CALL_ACTION' ? 'ACTION_RESPONSE' : 'MESSAGE_RESPONSE',
          originalType: message.type,
          componentId: message.componentId,
          success: result.success,
          result: result.result,
          error: result.error,
          requestId: message.requestId,
          responseId: message.responseId,
          timestamp: Date.now()
        }
        ws.send(JSON.stringify(response))
      }
    } catch (error: any) {
      ws.send(JSON.stringify({
        type: 'ERROR',
        componentId: message.componentId,
        error: error.message,
        requestId: message.requestId,
        timestamp: Date.now()
      }))
    }
  }

  private handleClose(ws: GenericWebSocket, code: number, reason: string): void {
    const connectionId = ws.data?.connectionId
    const componentCount = ws.data?.components?.size || 0

    this.registry.cleanupConnection(ws)
    this.roomManager.cleanupComponent(connectionId || '')
    if (connectionId) {
      this.connectionManager.cleanupConnection(connectionId)
      this.rateLimiter.remove(connectionId)
    }
    this.debugger.trackDisconnection(connectionId || '', componentCount)

    liveLog('websocket', null, `Connection closed: ${connectionId} (${componentCount} components)`)
  }

  private handleError(ws: GenericWebSocket, error: Error): void {
    console.error(`[LiveServer] WebSocket error:`, error.message)
  }

  // ===== Room Message Router =====

  private async handleRoomMessage(ws: GenericWebSocket, message: LiveMessage): Promise<void> {
    const { componentId } = message
    const roomId = (message as any).roomId || message.payload?.roomId

    switch (message.type) {
      case 'ROOM_JOIN': {
        const result = this.roomManager.joinRoom(componentId, roomId, ws, message.payload?.initialState)
        ws.send(JSON.stringify({
          type: 'ROOM_JOINED',
          componentId,
          payload: { roomId, state: result.state },
          requestId: message.requestId,
          timestamp: Date.now()
        }))
        break
      }
      case 'ROOM_LEAVE':
        this.roomManager.leaveRoom(componentId, roomId)
        ws.send(JSON.stringify({
          type: 'ROOM_LEFT',
          componentId,
          payload: { roomId },
          requestId: message.requestId,
          timestamp: Date.now()
        }))
        break
      case 'ROOM_EMIT':
        this.roomManager.emitToRoom(roomId, message.payload?.event, message.payload?.data, componentId)
        break
      case 'ROOM_STATE_SET':
        this.roomManager.setRoomState(roomId, message.payload?.state, componentId)
        break
      case 'ROOM_STATE_GET': {
        const state = this.roomManager.getRoomState(roomId)
        ws.send(JSON.stringify({
          type: 'ROOM_STATE',
          componentId,
          payload: { roomId, state },
          requestId: message.requestId,
          timestamp: Date.now()
        }))
        break
      }
    }
  }

  // ===== HTTP Monitoring Routes =====

  private buildHttpRoutes(prefix: string): HttpRouteDefinition[] {
    return [
      {
        method: 'GET',
        path: `${prefix}/stats`,
        handler: async () => ({
          body: {
            components: this.registry.getStats(),
            rooms: this.roomManager.getStats(),
            connections: this.connectionManager.getSystemStats(),
            uploads: this.fileUploadManager.getStats(),
            performance: this.performanceMonitor.getStats(),
          }
        }),
        metadata: { summary: 'Live Components system statistics', tags: ['live'] }
      },
      {
        method: 'GET',
        path: `${prefix}/components`,
        handler: async () => ({
          body: { names: this.registry.getRegisteredComponentNames() }
        }),
        metadata: { summary: 'List registered component names', tags: ['live'] }
      },
      {
        method: 'POST',
        path: `${prefix}/rooms/:roomId/messages`,
        handler: async (req) => {
          const roomId = req.params.roomId!
          this.roomManager.emitToRoom(roomId, 'message:new', req.body)
          return { body: { success: true, roomId } }
        },
        metadata: { summary: 'Send message to room via HTTP', tags: ['live', 'rooms'] }
      },
      {
        method: 'POST',
        path: `${prefix}/rooms/:roomId/emit`,
        handler: async (req) => {
          const roomId = req.params.roomId!
          const { event, data } = req.body as any
          this.roomManager.emitToRoom(roomId, event, data)
          return { body: { success: true, roomId, event } }
        },
        metadata: { summary: 'Emit custom event to room via HTTP', tags: ['live', 'rooms'] }
      },
    ]
  }
}
