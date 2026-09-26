// @fluxstack/live - LiveServer Orchestrator
//
// Main entry point: wire up transport, create singletons, expose public API.
// Usage:
//   const server = new LiveServer({ transport: new ElysiaTransport(app) })
//   await server.start()

import type { LiveTransport, GenericWebSocket, WebSocketConfig, HttpRouteDefinition } from '../transport/types'
import type { ClientMessageOf, FileUploadChunkMessage, WebSocketResponse } from '../protocol/messages'
import { isRecord, parseClientMessage } from '../protocol/validation'

/** Mensagens de sala já validadas (roomId normalizado). */
type RoomClientMessage = ClientMessageOf<'ROOM_JOIN' | 'ROOM_LEAVE' | 'ROOM_EMIT' | 'ROOM_STATE_SET' | 'ROOM_STATE_GET'>
import { RoomEventBus } from '../rooms/RoomEventBus'
import { LiveRoomManager } from '../rooms/LiveRoomManager'
import { LiveAuthManager } from '../auth/LiveAuthManager'
import { StateSignatureManager, type StateSignatureConfig } from '../security/StateSignature'
import { PerformanceMonitor, type PerformanceConfig } from '../monitoring/PerformanceMonitor'
import { FileUploadManager, type FileUploadConfig } from '../upload/FileUploadManager'
import { WebSocketConnectionManager, type ConnectionConfig } from '../connection/WebSocketConnectionManager'
import { ComponentRegistry } from '../component/ComponentRegistry'
import { setLiveComponentContext } from '../component/context'
import type { LiveComponentClass } from '../component/LiveComponent'
import { RateLimiterRegistry } from '../connection/RateLimiter'
import { liveLog } from '../debug/LiveLogger'
import { decodeBinaryChunk } from '../protocol/binary'
import { DEFAULT_WS_PATH, MAX_MESSAGE_SIZE, MAX_ROOMS_PER_CONNECTION, MAX_JSON_DEPTH } from '../protocol/constants'
import { sendImmediate, setResyncHandler } from '../transport/WsSendBatcher'
import { SseConnectionHub, type SseTransportOptions } from '../transport/sse'
import { HttpPollingHub, type HttpPollingTransportOptions } from '../transport/http-polling'
import { sanitizePayload } from '../security/sanitize'
import type { LiveAuthProvider } from '../auth/types'
import type { IRoomPubSubAdapter } from '../rooms/adapters'
import type { IClusterAdapter } from '../cluster/types'
import { ANONYMOUS_CONTEXT } from '../auth/LiveAuthContext'
import { RoomRegistry } from '../rooms/RoomRegistry'
import type { LiveRoomClass } from '../rooms/LiveRoom'
import { generateLiveComponentsFile } from '../build/index'
import { generateId as defaultGenerateId } from '../utils/generateId'
import { errorMessage } from '../utils/errors'

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
  /**
   * Maximum JSON nesting depth accepted on incoming WebSocket frames.
   * Defaults to MAX_JSON_DEPTH (32). Set to -1 to disable the check.
   *
   * Disabling the check is dangerous: a client can pin the JSON parser
   * with `'[' x 10_000` and exhaust CPU. Only opt out if you trust all
   * clients (e.g. internal tooling) and have an explicit reason.
   */
  maxJsonDepth?: number
  /**
   * Tamanho máximo de um frame recebido (JSON ou binário), em bytes.
   * Default: MAX_MESSAGE_SIZE (4MB).
   */
  maxMessageSize?: number
  /**
   * Habilita o transporte SSE (Server-Sent Events + POST HTTP) em paralelo ao
   * WebSocket. Clientes escolhem com `transport: 'sse' | 'auto'`.
   * Exige um adapter com `registerRawRoutes` (Elysia, Express, Fastify).
   * `true` usa os defaults (`/api/live/sse`).
   */
  sse?: boolean | SseTransportOptions
  /**
   * Habilita o transporte HTTP puro (long-polling + POST): o último recurso,
   * para redes onde nem WebSocket nem SSE passam. Clientes usam com
   * `transport: 'http' | 'auto'`. Exige `registerRawRoutes` no adapter.
   * `true` usa os defaults (`/api/live/http`).
   */
  http?: boolean | HttpPollingTransportOptions
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
  components?: LiveComponentClass[]
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
  /** Hub SSE (quando `options.sse` está ligado). */
  public sseHub: SseConnectionHub | null = null
  /** Hub HTTP long-polling (quando `options.http` está ligado). */
  public httpPollingHub: HttpPollingHub | null = null
  /** Connections with a backpressure resync coalesced for the current microtask. */
  private _pendingResync = new Set<GenericWebSocket>()

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

    // Recover connections that dropped outgoing messages to backpressure: the
    // batcher calls this with the affected ws; we re-send a full signed snapshot
    // of every component on it. Coalesce per-ws within a microtask so a burst of
    // drops triggers a single resync.
    setResyncHandler((ws) => {
      if (this._pendingResync.has(ws)) return
      this._pendingResync.add(ws)
      queueMicrotask(() => {
        this._pendingResync.delete(ws)
        this.registry.resyncConnection(ws)
      })
    })

    // Register statically-provided component classes (used in production bundles)
    if (options.components) {
      for (const componentClass of options.components) {
        const name = componentClass.componentName || componentClass.name
        this.registry.registerComponentClass(name, componentClass)
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

    // Transporte SSE: as mesmas callbacks, outro meio físico.
    if (this.options.sse) {
      if (!this.transport.registerRawRoutes) {
        throw new Error(
          `[LiveServer] sse habilitado, mas o transporte ${this.transport.constructor?.name ?? ''} ` +
          `não implementa registerRawRoutes(). Atualize o adapter ou desligue { sse }.`
        )
      }
      const sseOptions = this.options.sse === true ? {} : this.options.sse
      const { path: _wsPath, ...callbacks } = wsConfig
      this.sseHub = new SseConnectionHub(callbacks, {
        maxMessageSize: this.options.maxMessageSize ?? MAX_MESSAGE_SIZE,
        ...sseOptions,
      })
      await this.transport.registerRawRoutes(this.sseHub.routes())
      liveLog('lifecycle', null, `SSE transport enabled at ${this.sseHub.path}`)
    }

    // Transporte HTTP long-polling: mesmas callbacks, requisições comuns.
    if (this.options.http) {
      if (!this.transport.registerRawRoutes) {
        throw new Error(
          `[LiveServer] http habilitado, mas o transporte ${this.transport.constructor?.name ?? ''} ` +
          `não implementa registerRawRoutes(). Atualize o adapter ou desligue { http }.`
        )
      }
      const httpOptions = this.options.http === true ? {} : this.options.http
      const { path: _p, ...pollCallbacks } = wsConfig
      this.httpPollingHub = new HttpPollingHub(pollCallbacks, {
        maxMessageSize: this.options.maxMessageSize ?? MAX_MESSAGE_SIZE,
        ...httpOptions,
      })
      await this.transport.registerRawRoutes(this.httpPollingHub.routes())
      liveLog('lifecycle', null, `HTTP polling transport enabled at ${this.httpPollingHub.path}`)
    }

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
    this.sseHub?.closeAll()
    this.httpPollingHub?.closeAll()
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

    const maxSize = this.options.maxMessageSize ?? MAX_MESSAGE_SIZE

    // Binary protocol (file upload chunks)
    if (isBinary && (rawMessage instanceof ArrayBuffer || rawMessage instanceof Uint8Array)) {
      const buf = rawMessage instanceof Uint8Array
        ? rawMessage.buffer.slice(rawMessage.byteOffset, rawMessage.byteOffset + rawMessage.byteLength) as ArrayBuffer
        : rawMessage
      if (buf.byteLength > maxSize) {
        sendImmediate(ws, JSON.stringify({ type: 'ERROR', error: 'Message too large' }))
        return
      }
      try {
        const { header, data } = decodeBinaryChunk(buf)
        if (header.type === 'FILE_UPLOAD_CHUNK') {
          const chunkMessage: FileUploadChunkMessage = { ...header, data: '' }
          const progress = await this.fileUploadManager.receiveChunk(chunkMessage, data, ws.data?.connectionId)
          // ecoa o requestId: o client casa a resposta sem depender de heurística
          if (progress) sendImmediate(ws, JSON.stringify({ ...progress, requestId: header.requestId }))
        }
      } catch (error) {
        let requestId: string | undefined
        try { requestId = decodeBinaryChunk(buf).header.requestId } catch { /* header ilegível */ }
        sendImmediate(ws, JSON.stringify({ type: 'ERROR', error: errorMessage(error), requestId }))
      }
      return
    }

    // JSON protocol — check size before parsing
    const str = typeof rawMessage === 'string' ? rawMessage : new TextDecoder().decode(rawMessage as ArrayBuffer)
    if (str.length > maxSize) {
      sendImmediate(ws, JSON.stringify({ type: 'ERROR', error: 'Message too large' }))
      return
    }

    // Cheap pre-parse depth check — bail out before JSON.parse spends CPU on
    // a pathologically nested payload (10k '[' chars can pin the parser).
    // We count maximum opening-bracket nesting while ignoring brackets that
    // appear inside string literals. A negative limit disables the check.
    const depthLimit = this.options.maxJsonDepth ?? MAX_JSON_DEPTH
    if (depthLimit >= 0) {
      let depth = 0
      let max = 0
      let inString = false
      let escape = false
      for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i)
        if (escape) { escape = false; continue }
        if (inString) {
          if (ch === 0x5c /* \\ */) escape = true
          else if (ch === 0x22 /* " */) inString = false
          continue
        }
        if (ch === 0x22 /* " */) { inString = true }
        else if (ch === 0x7b /* { */ || ch === 0x5b /* [ */) {
          depth++
          if (depth > max) max = depth
          if (max > depthLimit) {
            sendImmediate(ws, JSON.stringify({ type: 'ERROR', error: `JSON nesting too deep (max ${depthLimit})` }))
            return
          }
        }
        else if (ch === 0x7d /* } */ || ch === 0x5d /* ] */) {
          depth--
        }
      }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(str)
    } catch {
      sendImmediate(ws, JSON.stringify({ type: 'ERROR', error: 'Invalid JSON' }))
      return
    }

    // Reject non-object root values (null, numbers, strings, arrays, booleans).
    // Valid LiveMessages are always objects — a bare value cannot be dispatched
    // and reading `.payload` on it would throw.
    if (!isRecord(parsed)) {
      sendImmediate(ws, JSON.stringify({ type: 'ERROR', error: 'Invalid message: expected object' }))
      return
    }

    // Strip prototype pollution keys from payload
    if (parsed.payload) {
      parsed.payload = sanitizePayload(parsed.payload)
    }

    // Validação de forma: cada tipo de mensagem precisa ter os campos que o
    // handler lê. Mensagem malformada → ERROR 'Invalid message' (nunca exceção).
    // Heartbeat do cliente: só mantém a conexão ativa, não exige resposta.
    // (Antes caía em "Unknown message type" a cada 30s.)
    if (parsed.type === 'PING') return

    const validation = parseClientMessage(parsed)
    if (!validation.ok) {
      if (validation.reason === 'unknown-type') {
        // Mesmo comportamento de antes: tipo desconhecido → MESSAGE_RESPONSE de falha.
        const response: WebSocketResponse = {
          type: 'MESSAGE_RESPONSE',
          componentId: validation.envelope.componentId,
          success: false,
          error: 'Unknown message type',
          requestId: validation.envelope.requestId,
        }
        sendImmediate(ws, JSON.stringify(response))
        return
      }
      sendImmediate(ws, JSON.stringify({
        type: 'ERROR',
        componentId: validation.envelope.componentId,
        success: false,
        error: `Invalid message: ${validation.error}`,
        requestId: validation.envelope.requestId,
      }))
      return
    }
    const message = validation.message

    try {
      switch (message.type) {
        // Auth message
        case 'AUTH': {
          const authContext = await this.authManager.authenticate(message.payload || {})
          if (ws.data) {
            ws.data.authContext = authContext
            // userId da conexão vem EXCLUSIVAMENTE da autenticação (quota de upload etc.)
            ws.data.userId = authContext.authenticated ? authContext.session?.id : undefined
          }
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
        case 'ROOM_JOIN':
        case 'ROOM_LEAVE':
        case 'ROOM_EMIT':
        case 'ROOM_STATE_SET':
        case 'ROOM_STATE_GET':
          await this.handleRoomMessage(ws, message)
          return

        // File upload messages
        case 'FILE_UPLOAD_START': {
          // O upload precisa estar ligado a um componente desta conexão.
          const ownsTarget = !message.componentId || !!ws.data?.components?.has(message.componentId)
          const result = ownsTarget
            ? await this.fileUploadManager.startUpload(message, ws.data?.userId, ws.data?.connectionId)
            : { success: false, error: 'Component not found for upload' }
          sendImmediate(ws, JSON.stringify({
            type: 'FILE_UPLOAD_START_RESPONSE',
            componentId: message.componentId,
            uploadId: isRecord(message.payload) ? message.payload.uploadId : undefined,
            success: result.success,
            error: result.error,
            requestId: message.requestId,
          }))
          return
        }

        case 'FILE_UPLOAD_CHUNK': {
          const progress = await this.fileUploadManager.receiveChunk(message, null, ws.data?.connectionId)
          if (progress) sendImmediate(ws, JSON.stringify({ ...progress, requestId: message.requestId }))
          return
        }

        case 'FILE_UPLOAD_COMPLETE': {
          const result = await this.fileUploadManager.completeUpload(message, ws.data?.connectionId)
          sendImmediate(ws, JSON.stringify({ ...result, requestId: message.requestId }))
          return
        }

        // Component rehydration
        case 'COMPONENT_REHYDRATE': {
          const result = await this.registry.rehydrateComponent(
            message.componentId,
            message.payload.component,
            message.payload.signedState,
            ws,
            {
              room: message.payload.room,
              // userId do cliente é ignorado — só o da autenticação da conexão.
              userId: ws.data?.authContext?.authenticated ? ws.data.authContext.session?.id : undefined,
            }
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

        // Delegate to registry (mount / unmount / action / property update)
        default: {
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
        }
      }
    } catch (error) {
      sendImmediate(ws, JSON.stringify({
        type: 'ERROR',
        componentId: message.componentId,
        error: errorMessage(error),
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
      // Uploads em andamento desta conexão liberam memória imediatamente.
      this.fileUploadManager.cancelConnectionUploads(connectionId)
    }

    liveLog('websocket', null, `Connection closed: ${connectionId} (${componentCount} components)`)
  }

  private handleError(ws: GenericWebSocket, error: Error): void {
    console.error(`[LiveServer] WebSocket error:`, errorMessage(error))
  }

  // ===== Room Message Router =====

  private async handleRoomMessage(ws: GenericWebSocket, message: RoomClientMessage): Promise<void> {
    const { componentId, roomId } = message

    // Posse: toda operação de sala age EM NOME de um componente — ele precisa
    // ser desta conexão. Sem isso, um cliente emitia/saía da sala como outro
    // (componentIds vazam em broadcasts).
    if (!componentId || !ws.data?.components?.has(componentId)) {
      sendImmediate(ws, JSON.stringify({
        type: 'ERROR',
        componentId,
        error: 'Component not found',
        requestId: message.requestId,
      }))
      return
    }

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
        const connRooms = ws.data?.rooms
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

        // Track rooms per connection (ws.data existe: a posse do componente foi checada acima)
        if (ws.data) {
          if (!ws.data.rooms) ws.data.rooms = new Set<string>()
          ws.data.rooms.add(roomId)
        }

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
        ws.data?.rooms?.delete(roomId)
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
        this.roomManager.emitToRoom(roomId, message.payload.event, message.payload.data, componentId)
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
        this.roomManager.setRoomStateFromClient(roomId, message.payload.state, componentId)
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
          const body: Record<string, unknown> = isRecord(req.body) ? req.body : {}
          if (typeof body.event !== 'string') {
            return { status: 400, body: { success: false, error: 'event must be a string' } }
          }
          const event = body.event
          this.roomManager.emitToRoom(roomId, event, body.data)
          return { body: { success: true, roomId, event } }
        },
        metadata: { summary: 'Emit custom event to room via HTTP', tags: ['live', 'rooms'] }
      },
    ]
  }
}
