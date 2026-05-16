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
import { LiveAuthManager } from '../auth/LiveAuthManager'
import { StateSignatureManager, type StateSignatureConfig } from '../security/StateSignature'
import { PerformanceMonitor, type PerformanceConfig } from '../monitoring/PerformanceMonitor'
import { FileUploadManager, type FileUploadConfig } from '../upload/FileUploadManager'
import { WebSocketConnectionManager, type ConnectionConfig } from '../connection/WebSocketConnectionManager'
import { ComponentRegistry } from '../component/ComponentRegistry'
import { setLiveComponentContext } from '../component/context'
import type { LiveComponent } from '../component/LiveComponent'
import { RateLimiterRegistry } from '../connection/RateLimiter'
import { liveLog } from '../debug/LiveLogger'
import { decodeBinaryChunk } from '../protocol/binary'
import { DEFAULT_WS_PATH, MAX_MESSAGE_SIZE, MAX_ROOMS_PER_CONNECTION } from '../protocol/constants'
import { sendImmediate } from '../transport/WsSendBatcher'
import { sanitizePayload } from '../security/sanitize'
import type { LiveAuthProvider } from '../auth/types'
import type { IRoomPubSubAdapter } from '../rooms/adapters'
import type { IClusterAdapter } from '../cluster/types'
import { ANONYMOUS_CONTEXT } from '../auth/LiveAuthContext'
import { RoomRegistry } from '../rooms/RoomRegistry'
import type { LiveRoomClass } from '../rooms/LiveRoom'
import { generateLiveComponentsFile } from '../build/index'
import { generateId as defaultGenerateId } from '../utils/generateId'

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
  /** Allowed origins for WebSocket connections (CSRF protection).
   *  When set, connections from unlisted origins are rejected.
   *  Example: ['https://myapp.com', 'http://localhost:3000'] */
  allowedOrigins?: string[]
  /** Optional cross-instance pub/sub adapter for horizontal scaling (e.g. Redis).
   *  When provided, room events, state changes, and membership are propagated
   *  across server instances. Without this, rooms are local to the current instance. */
  roomPubSub?: IRoomPubSubAdapter
  /** Optional cluster adapter for cross-instance component synchronization.
   *  When provided, singleton components are coordinated across instances,
   *  component state is mirrored to a shared store (Redis), and actions on
   *  remote singletons are forwarded to the owner instance. */
  cluster?: IClusterAdapter
  /** LiveRoom classes to register. These define typed rooms with lifecycle hooks. */
  rooms?: LiveRoomClass[]
  /** LiveComponent classes to register statically (e.g. from production bundles).
   *  Uses `static componentName` for the registry key, falling back to `class.name`. */
  components?: Array<new (...args: any[]) => LiveComponent<any>>
  /** Custom ID generator function. When provided, all auto-generated IDs
   *  (component IDs, connection IDs, cluster singleton IDs) will use this function
   *  instead of the default generators. Must return a unique string each call. */
  generateId?: () => string
}

export class LiveServer {
  // Public singletons (accessible for transport adapters & advanced usage)
  public readonly roomEvents: RoomEventBus
  public readonly roomManager: LiveRoomManager
  public readonly authManager: LiveAuthManager
  public readonly stateSignature: StateSignatureManager
  public readonly performanceMonitor: PerformanceMonitor
  public readonly fileUploadManager: FileUploadManager
  public readonly connectionManager: WebSocketConnectionManager
  public readonly registry: ComponentRegistry
  public readonly rateLimiter: RateLimiterRegistry
  public readonly roomRegistry: RoomRegistry

  private transport: LiveTransport
  private options: LiveServerOptions

  constructor(options: LiveServerOptions) {
    this.options = options
    this.transport = options.transport

    // Create all singletons
    this.roomEvents = new RoomEventBus()
    this.roomManager = new LiveRoomManager(this.roomEvents, options.roomPubSub)
    this.authManager = new LiveAuthManager()
    this.stateSignature = new StateSignatureManager(options.stateSignature)
    this.performanceMonitor = new PerformanceMonitor(options.performance)
    this.fileUploadManager = new FileUploadManager(options.fileUpload)
    this.connectionManager = new WebSocketConnectionManager(options.connection)
    this.rateLimiter = new RateLimiterRegistry(options.rateLimitMaxTokens, options.rateLimitRefillRate)

    // Room registry + wire to room manager
    this.roomRegistry = new RoomRegistry()
    this.roomManager.roomRegistry = this.roomRegistry
    if (options.rooms) {
      for (const roomClass of options.rooms) {
        this.roomRegistry.register(roomClass)
      }
    }

    this.registry = new ComponentRegistry({
      authManager: this.authManager,
      stateSignature: this.stateSignature,
      performanceMonitor: this.performanceMonitor,
      cluster: options.cluster,
      generateId: options.generateId,
    })

    // Register statically-provided component classes (used in production bundles)
    if (options.components) {
      for (const componentClass of options.components) {
        const name = (componentClass as any).componentName || componentClass.name
        this.registry.registerComponentClass(name, componentClass as any)
      }
    }

    // Set global context for LiveComponent base class
    setLiveComponentContext({
      roomEvents: this.roomEvents,
      roomManager: this.roomManager,
      generateId: options.generateId,
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
   * Register a LiveRoom class.
   * Can be called before start() to register room types dynamically.
   */
  useRoom(roomClass: LiveRoomClass): this {
    this.roomRegistry.register(roomClass)
    return this
  }

  /**
   * Start the LiveServer: register WS + HTTP handlers on the transport.
   */
  async start(): Promise<void> {
    // Auto-discover components if path provided
    if (this.options.componentsPath) {
      // Generate auto-generated-components.ts in the components dir (creates if missing)
      const count = generateLiveComponentsFile({ componentsDir: this.options.componentsPath })
      if (count >= 0) {
        liveLog('lifecycle', null, `Generated auto-components file (${count} components) in ${this.options.componentsPath}`)
      }

      // Runtime discovery — dynamically import and register all components
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

    // Cluster adapter startup
    if (this.options.cluster) {
      await this.options.cluster.start()
    }

    // Transport startup hook
    if (this.transport.start) {
      await this.transport.start()
    }

    liveLog('lifecycle', null, `LiveServer started (ws: ${wsConfig.path}${this.options.cluster ? ', cluster: enabled' : ''})`)
  }

  /**
   * Graceful shutdown.
   */
  async shutdown(): Promise<void> {
    this.registry.cleanup()
    this.connectionManager.shutdown()
    this.fileUploadManager.shutdown()
    this.stateSignature.shutdown()
    if (this.options.cluster) await this.options.cluster.shutdown()
    if (this.transport.shutdown) await this.transport.shutdown()
    liveLog('lifecycle', null, 'LiveServer shut down')
  }

  // ===== WebSocket Handlers =====

  private handleOpen(ws: GenericWebSocket): void {
    // Read origin before overwriting ws.data (adapter may have pre-set it)
    const origin = ws.data?.origin

    // Origin validation (CSRF protection)
    const allowedOrigins = this.options.allowedOrigins
    if (allowedOrigins && allowedOrigins.length > 0) {
      if (!origin || !allowedOrigins.includes(origin)) {
        liveLog('websocket', null, `Connection rejected: origin '${origin || 'none'}' not in allowedOrigins`)
        ws.close(4003, 'Origin not allowed')
        return
      }
    }

    const connectionId = this.options.generateId
      ? this.options.generateId()
      : defaultGenerateId()

    ws.data = {
      connectionId,
      components: new Map(),
      subscriptions: new Set(),
      connectedAt: new Date(),
      origin,
    }

    this.connectionManager.registerConnection(ws, connectionId)

    sendImmediate(ws, JSON.stringify({
      type: 'CONNECTION_ESTABLISHED',
      connectionId,
    }))

    liveLog('websocket', null, `Connection opened: ${connectionId}`)
  }

  private async handleMessage(ws: GenericWebSocket, rawMessage: unknown, isBinary: boolean): Promise<void> {
    // Rate limit
    const connectionId = ws.data?.connectionId
    if (connectionId) {
      const limiter = this.rateLimiter.get(connectionId)
      if (!limiter.tryConsume()) {
        sendImmediate(ws, JSON.stringify({ type: 'ERROR', error: 'Rate limit exceeded' }))
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
          if (progress) sendImmediate(ws, JSON.stringify(progress))
        }
      } catch (error: any) {
        sendImmediate(ws, JSON.stringify({ type: 'ERROR', error: error.message }))
      }
      return
    }

    // JSON protocol — check size before parsing
    const str = typeof rawMessage === 'string' ? rawMessage : new TextDecoder().decode(rawMessage as ArrayBuffer)
    if (str.length > MAX_MESSAGE_SIZE) {
      sendImmediate(ws, JSON.stringify({ type: 'ERROR', error: 'Message too large' }))
      return
    }

    let message: LiveMessage
    try {
      message = JSON.parse(str)
    } catch {
      sendImmediate(ws, JSON.stringify({ type: 'ERROR', error: 'Invalid JSON' }))
      return
    }

    // Strip prototype pollution keys from payload
    if (message.payload) {
      message.payload = sanitizePayload(message.payload)
    }

    try {
      // Auth message
      if (message.type === 'AUTH') {
        const authContext = await this.authManager.authenticate(message.payload || {})
        if (ws.data) ws.data.authContext = authContext
        sendImmediate(ws, JSON.stringify({
          type: 'AUTH_RESPONSE',
          success: authContext.authenticated,
          payload: authContext.authenticated
            ? { authenticated: true, session: authContext.session }
            : { authenticated: false, error: 'Authentication failed' },
          requestId: message.requestId,
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
        sendImmediate(ws, JSON.stringify({
          type: 'FILE_UPLOAD_START_RESPONSE',
          componentId: message.componentId,
          uploadId: message.payload?.uploadId,
          success: result.success,
          error: result.error,
          requestId: message.requestId,
        }))
        return
      }

      if (message.type === 'FILE_UPLOAD_CHUNK') {
        const progress = await this.fileUploadManager.receiveChunk(message as any)
        if (progress) sendImmediate(ws, JSON.stringify(progress))
        return
      }

      if (message.type === 'FILE_UPLOAD_COMPLETE') {
        const result = await this.fileUploadManager.completeUpload(message as any)
        sendImmediate(ws, JSON.stringify(result))
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
        sendImmediate(ws, JSON.stringify({
          type: 'COMPONENT_REHYDRATED',
          componentId: message.componentId,
          success: result.success,
          result: result.success ? { newComponentId: result.newComponentId } : undefined,
          error: result.error,
          requestId: message.requestId,
        }))
        return
      }

      // Delegate to registry
      const result = await this.registry.handleMessage(ws, message)

      if (result !== null) {
        const response: WebSocketResponse = {
          type: message.type === 'CALL_ACTION' ? 'ACTION_RESPONSE' : 'MESSAGE_RESPONSE',
          componentId: message.componentId,
          success: result.success,
          result: result.result,
          error: result.error,
          requestId: message.requestId,
        }
        sendImmediate(ws, JSON.stringify(response))
      }
    } catch (error: any) {
      sendImmediate(ws, JSON.stringify({
        type: 'ERROR',
        componentId: message.componentId,
        error: error.message,
        requestId: message.requestId,
      }))
    }
  }

  private async handleClose(ws: GenericWebSocket, code: number, reason: string): Promise<void> {
    const connectionId = ws.data?.connectionId
    const componentCount = ws.data?.components?.size || 0

    // Clean up rooms for each componentId (NOT connectionId — rooms are keyed by componentId)
    if (ws.data?.components) {
      for (const componentId of ws.data.components.keys()) {
        await this.roomManager.cleanupComponent(componentId as string)
      }
    }
    this.registry.cleanupConnection(ws)
    if (connectionId) {
      this.connectionManager.cleanupConnection(connectionId)
      this.rateLimiter.remove(connectionId)
    }

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
        // Block client join for LiveRoom-backed rooms (must use server-side $room().join())
        if (this.roomRegistry.resolveFromId(roomId)) {
          sendImmediate(ws, JSON.stringify({
            type: 'ERROR',
            componentId,
            error: 'Room requires server-side join via component action',
            requestId: message.requestId,
          }))
          break
        }

        // Per-connection room limit
        const connRooms = ws.data?.rooms as Set<string> | undefined
        if (connRooms && connRooms.size >= MAX_ROOMS_PER_CONNECTION) {
          sendImmediate(ws, JSON.stringify({
            type: 'ERROR',
            componentId,
            error: 'Room limit exceeded',
            requestId: message.requestId,
          }))
          break
        }

        // Auth: check if auth provider allows joining this room
        if (this.authManager.hasProviders()) {
          const authContext = ws.data?.authContext
          const authResult = await this.authManager.authorizeRoom(
            authContext || ANONYMOUS_CONTEXT,
            roomId,
          )
          if (!authResult.allowed) {
            sendImmediate(ws, JSON.stringify({
              type: 'ERROR',
              componentId,
              error: authResult.reason || 'Room access denied',
              requestId: message.requestId,
            }))
            break
          }
        }

        const result = await this.roomManager.joinRoom(componentId, roomId, ws, message.payload?.initialState)

        if ('rejected' in result && result.rejected) {
          sendImmediate(ws, JSON.stringify({
            type: 'ERROR',
            componentId,
            error: result.reason,
            requestId: message.requestId,
          }))
          break
        }

        // Track rooms per connection
        if (!ws.data!.rooms) ws.data!.rooms = new Set<string>()
        ;(ws.data!.rooms as Set<string>).add(roomId)

        sendImmediate(ws, JSON.stringify({
          type: 'ROOM_JOINED',
          componentId,
          payload: { roomId, state: result.state },
          requestId: message.requestId,
        }))
        break
      }
      case 'ROOM_LEAVE':
        await this.roomManager.leaveRoom(componentId, roomId)
        ;(ws.data?.rooms as Set<string> | undefined)?.delete(roomId)
        sendImmediate(ws, JSON.stringify({
          type: 'ROOM_LEFT',
          componentId,
          payload: { roomId },
          requestId: message.requestId,
        }))
        break
      case 'ROOM_EMIT': {
        // Security: must be a member of the room to emit
        if (!this.roomManager.isInRoom(componentId, roomId)) {
          sendImmediate(ws, JSON.stringify({
            type: 'ERROR',
            componentId,
            error: 'Not a member of this room',
            requestId: message.requestId,
          }))
          break
        }
        this.roomManager.emitToRoom(roomId, message.payload?.event, message.payload?.data, componentId)
        break
      }
      case 'ROOM_STATE_SET': {
        // Security: must be a member of the room
        if (!this.roomManager.isInRoom(componentId, roomId)) {
          sendImmediate(ws, JSON.stringify({
            type: 'ERROR',
            componentId,
            error: 'Not a member of this room',
            requestId: message.requestId,
          }))
          break
        }
        // Security: block client writes when serverOnlyState is enabled
        if (this.roomManager.isServerOnlyState(roomId)) {
          sendImmediate(ws, JSON.stringify({
            type: 'ERROR',
            componentId,
            error: 'Room state is server-only',
            requestId: message.requestId,
          }))
          break
        }
        // Use the client-facing variant: filters $-prefix + prototype-pollution
        // keys so the client can't inject server-only fields into shared room state.
        this.roomManager.setRoomStateFromClient(roomId, message.payload?.state, componentId)
        break
      }
      case 'ROOM_STATE_GET': {
        // Security: must be a member of the room to read state
        if (!this.roomManager.isInRoom(componentId, roomId)) {
          sendImmediate(ws, JSON.stringify({
            type: 'ERROR',
            componentId,
            error: 'Not a member of this room',
            requestId: message.requestId,
          }))
          break
        }
        const state = this.roomManager.getRoomState(roomId)
        sendImmediate(ws, JSON.stringify({
          type: 'ROOM_STATE',
          componentId,
          payload: { roomId, state },
          requestId: message.requestId,
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
        handler: () => ({
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
        handler: () => ({
          body: { names: this.registry.getRegisteredComponentNames() }
        }),
        metadata: { summary: 'List registered component names', tags: ['live'] }
      },
      {
        method: 'POST',
        path: `${prefix}/rooms/:roomId/messages`,
        handler: (req) => {
          const roomId = req.params.roomId!
          this.roomManager.emitToRoom(roomId, 'message:new', req.body)
          return { body: { success: true, roomId } }
        },
        metadata: { summary: 'Send message to room via HTTP', tags: ['live', 'rooms'] }
      },
      {
        method: 'POST',
        path: `${prefix}/rooms/:roomId/emit`,
        handler: (req) => {
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
