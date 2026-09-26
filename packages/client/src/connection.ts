// @fluxstack/live-client - Connection Manager
//
// Conexão agnóstica de framework E de transporte: auto-reconnect, heartbeat,
// request-response e roteamento por componente. O transporte (WebSocket, SSE
// ou custom) é plugável — ver ./transports.ts.

import type { WebSocketResponse } from '@fluxstack/live'
import { generateId } from './generateId'
import {
  clientMessages,
  isRecord,
  readAuthPayload,
  type LiveOutgoingMessage,
} from './protocol'
import {
  createClientTransport,
  resolveTransportEndpoints,
  WebSocketClientTransport,
  type ClientTransport,
  type ClientTransportEndpoints,
  type ClientTransportKind,
  type ClientTransportOption,
  type ClientTransportMode,
  type ClientTransportFactory,
  resolveTransportChain,
} from './transports'

/**
 * Deep-freeze a session mirror so client code cannot mutate fields locally.
 * The server-side `AuthenticatedContext` is already frozen — this mirrors
 * that guarantee on the client so accidental writes
 * (`proxy.$auth.session.plan = 'enterprise'`) throw in strict mode instead
 * of silently corrupting the shared reference.
 *
 * The deep walk is bounded (depth 8) — auth sessions are leaf-ish objects,
 * not arbitrary graphs, so this is cheap.
 */
function deepFreezeSession(s: unknown, depth = 0): unknown {
  if (s === null || typeof s !== 'object' || depth > 8) return s
  if (Object.isFrozen(s)) return s
  for (const key of Object.keys(s as Record<string, unknown>)) {
    deepFreezeSession((s as Record<string, unknown>)[key], depth + 1)
  }
  return Object.freeze(s)
}

/** Congela o espelho da sessão (a forma já foi validada por `readAuthPayload`). */
function freezeSession(session: Record<string, unknown> | null): Record<string, unknown> | null {
  deepFreezeSession(session)
  return session
}

/** Chave de correlação de upload de uma mensagem enviada (ver `uploadAliases`). */
function uploadAliasOf(message: unknown): string | undefined {
  if (!isRecord(message) || typeof message.uploadId !== 'string') return undefined
  if (message.type === 'FILE_UPLOAD_CHUNK' && typeof message.chunkIndex === 'number') {
    return `${message.uploadId}:${message.chunkIndex}`
  }
  if (message.type === 'FILE_UPLOAD_COMPLETE') return `${message.uploadId}:complete`
  return undefined
}

/** Header JSON de um chunk binário: `[u32 LE tamanho][JSON][dados]` (ver createBinaryChunkMessage). */
function readBinaryChunkHeader(data: ArrayBuffer): unknown {
  try {
    if (data.byteLength < 4) return undefined
    const len = new DataView(data).getUint32(0, true)
    if (4 + len > data.byteLength) return undefined
    return JSON.parse(new TextDecoder().decode(new Uint8Array(data, 4, len)))
  } catch {
    return undefined
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** Auth credentials to send during WebSocket connection */
export interface LiveAuthOptions {
  /** JWT or opaque token */
  token?: string
  /** Provider name (if multiple auth providers configured) */
  provider?: string
  /** Additional credentials (publicKey, signature, etc.) */
  [key: string]: unknown
}

export interface LiveConnectionOptions {
  /** WebSocket URL. Auto-detected from window.location if omitted. */
  url?: string
  /**
   * Transporte: 'websocket' (padrão), 'sse' (Server-Sent Events + POST HTTP),
   * 'http' (long-polling + POST), 'auto' (= ['websocket', 'sse', 'http']),
   * uma lista em ordem de preferência (ex.: ['sse', 'http']) — desce para o
   * próximo se o atual nunca abrir — ou uma fábrica custom.
   */
  transport?: ClientTransportOption
  /** URL base do SSE. Default: derivada de `url` (`/api/live/ws` → `/api/live/sse`). */
  sseUrl?: string
  /** URL base do HTTP long-polling. Default: derivada de `url` (`/api/live/ws` → `/api/live/http`). */
  httpUrl?: string
  /** Auth credentials to send on connection */
  auth?: LiveAuthOptions
  /** Auto-connect on creation. Default: true */
  autoConnect?: boolean
  /** Reconnect interval in ms. Default: 1000 */
  reconnectInterval?: number
  /** Max reconnect attempts. Default: 5 */
  maxReconnectAttempts?: number
  /** Heartbeat interval in ms. Default: 30000 */
  heartbeatInterval?: number
  /** Enable debug logging. Default: false */
  debug?: boolean
}

/** Auth state exposed to the client */
export interface LiveClientAuth {
  authenticated: boolean
  /** Session data from the server. Shape defined by your LiveAuthProvider. */
  session: Record<string, unknown> | null
}

export interface LiveConnectionState {
  connected: boolean
  /** transporte em uso ('websocket' | 'sse' | custom) — null antes de conectar */
  transport: ClientTransportKind | null
  connecting: boolean
  error: string | null
  connectionId: string | null
  authenticated: boolean
  /** Auth context with session data */
  auth: LiveClientAuth
}

type StateChangeCallback = (state: LiveConnectionState) => void
type ComponentCallback = (message: WebSocketResponse) => void

/**
 * Mensagens para um componente que ainda não registrou callback ficam
 * guardadas por pouco tempo e são entregues no `registerComponent`.
 *
 * Por quê: o servidor envia (e dá flush) nos eventos do componente ANTES da
 * resposta do request — `STATE_REHYDRATED` chega antes de `COMPONENT_REHYDRATED`,
 * e deltas emitidos em `onMount` chegam antes da resposta do mount. O cliente
 * só conhece o componentId depois da resposta, então sem este buffer essas
 * mensagens eram descartadas ("No callback registered").
 */
const UNROUTED_TTL_MS = 5000
const UNROUTED_MAX_PER_COMPONENT = 32
const UNROUTED_MAX_COMPONENTS = 64

/**
 * Framework-agnostic WebSocket connection manager.
 * Handles reconnection, heartbeat, request-response pattern, and message routing.
 */
export class LiveConnection {
  private transport: ClientTransport | null = null
  private readonly endpoints: ClientTransportEndpoints
  /** modo efetivo (em 'auto' começa em websocket e pode cair para sse) */
  private activeMode: ClientTransportMode | ClientTransportFactory
  /** cadeia de fallback resolvida a partir de `options.transport` */
  private readonly chain: ReadonlyArray<ClientTransportMode | ClientTransportFactory>
  /** falhas seguidas do transporte atual sem nunca abrir (modo 'auto') */
  private autoWsFailures = 0
  /** ordem de fallback do modo 'auto': do melhor para o que passa em qualquer rede */
  private static readonly AUTO_FALLBACK_AFTER = 2
  private options: Required<Omit<LiveConnectionOptions, 'url' | 'auth' | 'transport' | 'sseUrl' | 'httpUrl'>> & {
    url?: string
    auth?: LiveAuthOptions
    transport: ClientTransportOption
    sseUrl?: string
    httpUrl?: string
  }
  private reconnectAttempts = 0
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null
  private manualReconnectTimeout: ReturnType<typeof setTimeout> | null = null
  private destroyed = false
  /** true quando disconnect() foi chamado de propósito — bloqueia auto-reconnect */
  private intentionalClose = false
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null
  private componentCallbacks = new Map<string, ComponentCallback>()
  private binaryCallbacks = new Map<string, (payload: Uint8Array) => void>()
  private roomBinaryHandlers = new Set<(frame: Uint8Array) => void>()
  private _textDecoder = new TextDecoder()
  private pendingRequests = new Map<string, {
    resolve: (value: WebSocketResponse) => void
    reject: (error: Error) => void
    timeout: ReturnType<typeof setTimeout>
    /** chave de upload (ver uploadAliases) — removida junto com o request */
    uploadAlias?: string
  }>()
  /**
   * `uploadId:chunkIndex` / `uploadId:complete` → requestId.
   * O servidor responde FILE_UPLOAD_PROGRESS / FILE_UPLOAD_COMPLETE SEM ecoar o
   * `requestId`; sem esta correlação cada chunk esperava até o timeout e o
   * upload falhava. Quando a resposta trouxer `requestId`, o caminho normal vence.
   */
  private uploadAliases = new Map<string, string>()
  /** componentId → mensagens que chegaram antes do registerComponent (ver UNROUTED_TTL_MS). */
  private unrouted = new Map<string, { at: number; messages: WebSocketResponse[] }>()
  private stateListeners = new Set<StateChangeCallback>()
  private _state: LiveConnectionState = {
    connected: false,
    transport: null,
    connecting: false,
    error: null,
    connectionId: null,
    authenticated: false,
    auth: { authenticated: false, session: null },
  }

  constructor(options: LiveConnectionOptions = {}) {
    this.options = {
      url: options.url,
      auth: options.auth,
      transport: options.transport ?? 'websocket',
      sseUrl: options.sseUrl,
      httpUrl: options.httpUrl,
      autoConnect: options.autoConnect ?? true,
      reconnectInterval: options.reconnectInterval ?? 1000,
      // Infinito por padrão: app tempo real não deve "morrer" após N falhas e
      // exigir F5. O backoff tem teto (16s), então retry infinito é barato.
      // 0 ou Infinity = infinito. Um número finito mantém o limite (compat).
      maxReconnectAttempts: options.maxReconnectAttempts ?? Infinity,
      heartbeatInterval: options.heartbeatInterval ?? 30000,
      debug: options.debug ?? false,
    }
    this.endpoints = resolveTransportEndpoints(this.options.url, this.options.sseUrl, this.options.httpUrl)
    this.chain = resolveTransportChain(this.options.transport)
    this.activeMode = this.chain[0]!

    // Reconexão guiada pela rede/visibilidade: quando o navegador volta a ficar
    // online ou a aba volta ao foco, tentamos reconectar IMEDIATAMENTE (sem
    // esperar o backoff). Essencial pra tempo real: fechou o laptop, reabriu →
    // reconecta na hora, sem o usuário precisar interagir.
    this.installNetworkListeners()

    if (this.options.autoConnect) {
      this.connect()
    }
  }

  private onlineHandler: (() => void) | null = null
  private visibilityHandler: (() => void) | null = null

  private installNetworkListeners(): void {
    if (typeof window === 'undefined') return

    // Reconexão imediata: cancela o backoff pendente e tenta já (resetando o
    // contador). connect() é no-op se já estiver CONNECTING/OPEN.
    const reconnectNow = () => {
      if (this.destroyed || this.intentionalClose) return
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout)
        this.reconnectTimeout = null
      }
      this.reconnectAttempts = 0
      this.connect()
    }
    this.onlineHandler = () => {
      this.log('Network back online — reconnecting')
      reconnectNow()
    }
    this.visibilityHandler = () => {
      if (document.visibilityState === 'visible' && !this.transport?.isOpen) {
        this.log('Tab visible again — reconnecting')
        reconnectNow()
      }
    }
    window.addEventListener('online', this.onlineHandler)
    document.addEventListener('visibilitychange', this.visibilityHandler)
  }

  private removeNetworkListeners(): void {
    if (typeof window === 'undefined') return
    if (this.onlineHandler) window.removeEventListener('online', this.onlineHandler)
    if (this.visibilityHandler) document.removeEventListener('visibilitychange', this.visibilityHandler)
    this.onlineHandler = null
    this.visibilityHandler = null
  }

  get state(): LiveConnectionState {
    return { ...this._state }
  }

  /** Subscribe to connection state changes */
  onStateChange(callback: StateChangeCallback): () => void {
    this.stateListeners.add(callback)
    return () => { this.stateListeners.delete(callback) }
  }

  private setState(patch: Partial<LiveConnectionState>) {
    this._state = { ...this._state, ...patch }
    for (const cb of this.stateListeners) {
      cb(this._state)
    }
  }

  private log(message: string, data?: unknown) {
    if (this.options.debug) {
      console.log(`[LiveConnection] ${message}`, data || '')
    }
  }

  /** Generate unique request ID */
  generateRequestId(): string {
    return generateId()
  }

  /** Conecta usando o transporte configurado. */
  connect(): void {
    if (this.transport?.isConnecting) {
      this.log('Already connecting, skipping...')
      return
    }
    if (this.transport?.isOpen) {
      this.log('Already connected, skipping...')
      return
    }

    // Reconectar (manual, online, visibility, ou auto) limpa a flag de
    // fechamento intencional — a partir daqui quedas voltam a reconectar.
    this.intentionalClose = false
    this.setState({ connecting: true, error: null })

    try {
      const transport = createClientTransport(this.activeMode, this.endpoints)
      this.transport = transport
      let opened = false
      this.log('Connecting...', { transport: transport.kind, endpoints: this.endpoints })

      transport.open({
        onOpen: () => {
          if (this.transport !== transport) return
          opened = true
          this.autoWsFailures = 0
          this.log('Connected', { transport: transport.kind })
          this.setState({ connected: true, connecting: false, transport: transport.kind })
          this.reconnectAttempts = 0
          this.startHeartbeat()
        },
        onMessage: (data) => {
          if (this.transport !== transport) return
          this.handleIncoming(data)
        },
        onError: (error) => {
          if (this.transport !== transport) return
          this.log('Transport error', { transport: transport.kind, error: error.message })
          this.setState({ error: `${transport.kind} connection error`, connecting: false })
        },
        onClose: (code, reason) => {
          if (this.transport !== transport) return
          this.transport = null
          this.log('Disconnected', { code, reason })
          this.setState({ connected: false, connecting: false, connectionId: null, authenticated: false, auth: { authenticated: false, session: null } })
          this.stopHeartbeat()
          // A resposta de um pedido em voo nunca chegará por uma conexão morta:
          // rejeita já, em vez de esperar o timeout (mount/rehydrate/action
          // ficavam parados até 5-10s antes de tentar na conexão nova).
          this.rejectPendingRequests(`Connection lost (${code}${reason ? `: ${reason}` : ''})`)

          // Server rejected connection due to CSRF origin validation — don't retry
          if (code === 4003) {
            this.setState({ error: 'Connection rejected: origin not allowed' })
            return
          }

          // 'auto': transporte que nunca abre (proxy/firewall) → desce um nível:
          // websocket → sse → http. HTTP puro é o piso e passa em qualquer rede.
          if (!opened) {
            const chain = this.chain
            const idx = chain.indexOf(this.activeMode)
            if (idx >= 0 && idx < chain.length - 1) {
              this.autoWsFailures++
              if (this.autoWsFailures >= LiveConnection.AUTO_FALLBACK_AFTER) {
                const next = chain[idx + 1]!
                this.log(`${String(this.activeMode)} unavailable — falling back to ${String(next)}`)
                this.activeMode = next
                this.autoWsFailures = 0
                this.reconnectAttempts = 0
              }
            }
          }

          this.attemptReconnect()
        },
      })
    } catch (error) {
      this.setState({
        connecting: false,
        error: error instanceof Error ? error.message : 'Connection failed',
      })
    }
  }

  /** Decodifica um frame recebido (texto JSON — possivelmente em lote — ou binário). */
  private handleIncoming(data: string | ArrayBuffer): void {
    if (typeof data !== 'string') {
      this.handleBinaryMessage(new Uint8Array(data))
      return
    }
    try {
      const parsed = JSON.parse(data) as WebSocketResponse | WebSocketResponse[]
      // Server may send batched messages as a JSON array
      const messages = Array.isArray(parsed) ? parsed : [parsed]
      for (const msg of messages) {
        this.log('Received', { type: msg.type, componentId: msg.componentId })
        this.handleMessage(msg)
      }
    } catch {
      this.log('Failed to parse message')
      this.setState({ error: 'Failed to parse message' })
    }
  }

  /** Disconnect from WebSocket server */
  disconnect(): void {
    // Marca fechamento INTENCIONAL: o onclose resultante NÃO deve disparar
    // reconexão automática (senão, com retry infinito, o disconnect manual
    // ficaria reconectando pra sempre). reconnect()/connect() limpam a flag.
    this.intentionalClose = true
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }
    if (this.manualReconnectTimeout) {
      clearTimeout(this.manualReconnectTimeout)
      this.manualReconnectTimeout = null
    }
    this.stopHeartbeat()
    if (this.transport) {
      const t = this.transport
      this.transport = null
      t.close()
    }
    this.reconnectAttempts = this.options.maxReconnectAttempts
    this.setState({ connected: false, connecting: false, connectionId: null })
  }

  /** Manual reconnect */
  reconnect(): void {
    if (this.destroyed) return
    this.disconnect()
    this.reconnectAttempts = 0
    this.manualReconnectTimeout = setTimeout(() => {
      this.manualReconnectTimeout = null
      if (this.destroyed) return
      this.connect()
    }, 100)
  }

  private attemptReconnect(): void {
    if (this.destroyed || this.intentionalClose) return
    // 0 ou Infinity = reconectar indefinidamente (default p/ tempo real).
    const max = this.options.maxReconnectAttempts
    const infinite = max === 0 || max === Infinity

    if (infinite || this.reconnectAttempts < max) {
      this.reconnectAttempts++
      // Backoff exponencial com teto de 16s — no modo infinito, fica tentando
      // a cada 16s indefinidamente (barato) em vez de desistir.
      const delay = Math.min(
        this.options.reconnectInterval * Math.pow(2, this.reconnectAttempts - 1),
        16000
      )
      const label = infinite ? `${this.reconnectAttempts}` : `${this.reconnectAttempts}/${max}`
      this.log(`Reconnecting in ${delay}ms... (${label})`)
      this.reconnectTimeout = setTimeout(() => this.connect(), delay)
    } else {
      this.setState({ error: 'Max reconnection attempts reached' })
    }
  }

  private consecutiveHeartbeatFailures = 0
  private static readonly MAX_HEARTBEAT_FAILURES = 3

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.consecutiveHeartbeatFailures = 0
    this.heartbeatInterval = setInterval(() => {
      if (this.transport?.isOpen) {
        this.sendMessage(clientMessages.ping()).catch(() => {
          this.consecutiveHeartbeatFailures++
          this.log(`Heartbeat failed (${this.consecutiveHeartbeatFailures}/${LiveConnection.MAX_HEARTBEAT_FAILURES})`)
          if (this.consecutiveHeartbeatFailures >= LiveConnection.MAX_HEARTBEAT_FAILURES) {
            this.log('Too many heartbeat failures, reconnecting...')
            this.setState({ error: 'Heartbeat failed' })
            this.reconnect()
          }
        })
        this.consecutiveHeartbeatFailures = 0
      }
    }, this.options.heartbeatInterval)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
  }

  private handleMessage(response: WebSocketResponse): void {
    // Handle connection established
    if (response.type === 'CONNECTION_ESTABLISHED') {
      // `authenticated` vem no topo do CONNECTION_ESTABLISHED (fora do tipo WebSocketResponse).
      const established: unknown = response
      this.setState({
        connectionId: response.connectionId || null,
        authenticated: isRecord(established) && established.authenticated === true,
      })

      // Send AUTH message if credentials provided (always via socket, never in URL)
      const auth = this.options.auth
      if (auth && Object.keys(auth).some(k => auth[k])) {
        this.sendMessageAndWait(clientMessages.auth(auth))
          .then(authResp => {
            const result = readAuthPayload(authResp)
            if (result.authenticated) {
              this.setState({
                authenticated: true,
                auth: {
                  authenticated: true,
                  session: freezeSession(result.session),
                },
              })
            }
          })
          .catch(() => {})
      }
    }

    // Handle auth response
    if (response.type === 'AUTH_RESPONSE') {
      const { authenticated, session } = readAuthPayload(response)
      this.setState({
        authenticated,
        auth: {
          authenticated,
          // Deep-freeze the mirror so consumer code cannot mutate locally
          // (mirrors the server-side AuthenticatedContext.freeze).
          session: authenticated ? freezeSession(session) : null,
        },
      })
    }

    // Handle pending requests (request-response pattern)
    const pendingId = response.requestId && this.pendingRequests.has(response.requestId)
      ? response.requestId
      : this.uploadRequestIdFor(response)
    if (pendingId) {
      const request = this.pendingRequests.get(pendingId)!
      this.settlePending(pendingId)

      // Falha = `success: false` OU `type: 'ERROR'` (os erros de sala/posse do
      // servidor vêm como ERROR sem `success`; antes resolviam como se fosse ok).
      const failed = response.success === false || response.type === 'ERROR'
      if (!failed || response.error?.includes('COMPONENT_REHYDRATION_REQUIRED')) {
        request.resolve(response)
      } else {
        request.reject(new Error(response.error || 'Request failed'))
      }
      return
    }

    // Broadcast messages go to ALL components (not just sender)
    if (response.type === 'BROADCAST') {
      this.componentCallbacks.forEach((callback, compId) => {
        if (compId !== response.componentId) {
          callback(response)
        }
      })
      return
    }

    // Route message to specific component
    if (response.componentId) {
      const callback = this.componentCallbacks.get(response.componentId)
      if (callback) {
        callback(response)
      } else {
        this.bufferUnrouted(response.componentId, response)
      }
    }
  }

  /** Remove um request pendente (e seu alias de upload), cancelando o timeout. */
  private settlePending(requestId: string): void {
    const request = this.pendingRequests.get(requestId)
    if (!request) return
    clearTimeout(request.timeout)
    this.pendingRequests.delete(requestId)
    if (request.uploadAlias && this.uploadAliases.get(request.uploadAlias) === requestId) {
      this.uploadAliases.delete(request.uploadAlias)
    }
  }

  /** requestId pendente correspondente a uma resposta de upload sem requestId. */
  private uploadRequestIdFor(response: WebSocketResponse): string | undefined {
    if (typeof response.uploadId !== 'string') return undefined
    let key: string | undefined
    if (response.type === 'FILE_UPLOAD_PROGRESS' && typeof response.chunkIndex === 'number') {
      key = `${response.uploadId}:${response.chunkIndex}`
    } else if (response.type === 'FILE_UPLOAD_COMPLETE') {
      key = `${response.uploadId}:complete`
    }
    const requestId = key ? this.uploadAliases.get(key) : undefined
    return requestId && this.pendingRequests.has(requestId) ? requestId : undefined
  }

  /** Registra um request pendente (com alias de upload, quando houver). */
  private addPending(
    requestId: string,
    resolve: (value: WebSocketResponse) => void,
    reject: (error: Error) => void,
    timeoutMs: number,
    timeoutMessage: string,
    uploadAlias: string | undefined,
  ): void {
    const timeout = setTimeout(() => {
      this.settlePending(requestId)
      reject(new Error(timeoutMessage))
    }, timeoutMs)
    this.pendingRequests.set(requestId, { resolve, reject, timeout, uploadAlias })
    if (uploadAlias) this.uploadAliases.set(uploadAlias, requestId)
  }

  /** Guarda mensagem de componente ainda sem callback (entregue no registerComponent). */
  private bufferUnrouted(componentId: string, response: WebSocketResponse): void {
    const now = Date.now()
    // Descarta entradas vencidas antes de crescer.
    for (const [id, entry] of this.unrouted) {
      if (now - entry.at > UNROUTED_TTL_MS) this.unrouted.delete(id)
    }
    let entry = this.unrouted.get(componentId)
    if (!entry) {
      if (this.unrouted.size >= UNROUTED_MAX_COMPONENTS) {
        const oldest = this.unrouted.keys().next().value
        if (oldest !== undefined) this.unrouted.delete(oldest)
      }
      entry = { at: now, messages: [] }
      this.unrouted.set(componentId, entry)
    }
    if (entry.messages.length >= UNROUTED_MAX_PER_COMPONENT) entry.messages.shift()
    entry.messages.push(response)
    this.log('No callback registered yet — buffered message for component:', componentId)
  }

  /** Send message without waiting for response */
  async sendMessage(message: LiveOutgoingMessage): Promise<void> {
    if (!this.transport?.isOpen) {
      throw new Error('WebSocket is not connected')
    }
    this.transport.send(JSON.stringify(message))
    this.log('Sent', { type: message.type, componentId: 'componentId' in message ? message.componentId : undefined })
  }

  /** Send message and wait for response */
  async sendMessageAndWait(message: LiveOutgoingMessage, timeout = 10000): Promise<WebSocketResponse> {
    return new Promise((resolve, reject) => {
      const transport = this.transport
      if (!transport?.isOpen) {
        reject(new Error('WebSocket is not connected'))
        return
      }

      const requestId = this.generateRequestId()
      this.addPending(requestId, resolve, reject, timeout, `Request timeout after ${timeout}ms`, uploadAliasOf(message))

      try {
        const messageWithRequestId = {
          ...message,
          requestId,
          expectResponse: true,
        }
        transport.send(JSON.stringify(messageWithRequestId))
        this.log('Sent with requestId', { requestId, type: message.type })
      } catch (error) {
        this.settlePending(requestId)
        reject(toError(error))
      }
    })
  }

  /** Send binary data and wait for response (for file uploads) */
  async sendBinaryAndWait(data: ArrayBuffer, requestId: string, timeout = 10000): Promise<WebSocketResponse> {
    return new Promise((resolve, reject) => {
      const transport = this.transport
      if (!transport?.isOpen) {
        reject(new Error('WebSocket is not connected'))
        return
      }

      this.addPending(requestId, resolve, reject, timeout, `Binary request timeout after ${timeout}ms`, uploadAliasOf(readBinaryChunkHeader(data)))

      try {
        transport.send(data)
        this.log('Sent binary', { requestId, size: data.byteLength })
      } catch (error) {
        this.settlePending(requestId)
        reject(toError(error))
      }
    })
  }

  /** Parse and route binary frames (state delta, room events, room state) */
  private handleBinaryMessage(buffer: Uint8Array): void {
    if (buffer.length < 3) return

    const frameType = buffer[0]

    if (frameType === 0x01) {
      // BINARY_STATE_DELTA: [0x01][idLen:u8][compId:utf8][payload]
      const idLen = buffer[1]
      if (buffer.length < 2 + idLen) return
      const componentId = this._textDecoder.decode(buffer.subarray(2, 2 + idLen))
      const payload = buffer.subarray(2 + idLen)

      const callback = this.binaryCallbacks.get(componentId)
      if (callback) callback(payload)
    } else if (frameType === 0x02 || frameType === 0x03) {
      // BINARY_ROOM_EVENT (0x02) or BINARY_ROOM_STATE (0x03)
      // Route to all registered room binary handlers (RoomManager instances)
      for (const callback of this.roomBinaryHandlers) {
        callback(buffer)
      }
    }
  }

  /** Register a handler for binary room frames (0x02 / 0x03). Returns unsubscribe. */
  registerRoomBinaryHandler(callback: (frame: Uint8Array) => void): () => void {
    this.roomBinaryHandlers.add(callback)
    return () => {
      this.roomBinaryHandlers.delete(callback)
    }
  }

  /** Register a binary message handler for a component */
  registerBinaryHandler(componentId: string, callback: (payload: Uint8Array) => void): () => void {
    this.binaryCallbacks.set(componentId, callback)
    return () => { this.binaryCallbacks.delete(componentId) }
  }

  /** Register a component message callback */
  registerComponent(componentId: string, callback: ComponentCallback): () => void {
    this.log('Registering component', componentId)
    this.componentCallbacks.set(componentId, callback)
    // Entrega o que chegou antes do registro (ex.: STATE_REHYDRATED, deltas do onMount).
    const buffered = this.unrouted.get(componentId)
    if (buffered) {
      this.unrouted.delete(componentId)
      if (Date.now() - buffered.at <= UNROUTED_TTL_MS) {
        for (const msg of buffered.messages) {
          // O callback pode ter sido trocado/removido por uma mensagem anterior.
          if (this.componentCallbacks.get(componentId) !== callback) break
          callback(msg)
        }
      }
    }
    return () => {
      this.componentCallbacks.delete(componentId)
      this.log('Unregistered component', componentId)
    }
  }

  /** Unregister a component */
  unregisterComponent(componentId: string): void {
    this.componentCallbacks.delete(componentId)
  }

  /** Authenticate (or re-authenticate) the WebSocket connection */
  async authenticate(credentials: LiveAuthOptions): Promise<boolean> {
    try {
      const response = await this.sendMessageAndWait(clientMessages.auth(credentials), 5000)
      const { authenticated: success, session } = readAuthPayload(response)
      this.setState({
        authenticated: success,
        auth: {
          authenticated: success,
          // Deep-freeze the mirror (see deepFreezeSession at top).
          session: success ? freezeSession(session) : null,
        },
      })
      return success
    } catch {
      return false
    }
  }

  /** Rejeita todos os pedidos pendentes (conexão caiu ou foi destruída). */
  private rejectPendingRequests(message: string): void {
    for (const [, req] of this.pendingRequests) {
      clearTimeout(req.timeout)
      req.reject(new Error(message))
    }
    this.pendingRequests.clear()
  }

  /** WebSocket nativo quando o transporte ativo é WebSocket (null em SSE/custom). */
  getWebSocket(): WebSocket | null {
    return this.transport instanceof WebSocketClientTransport ? this.transport.socket : null
  }

  /** Transporte ativo (ou null quando desconectado). */
  getTransport(): ClientTransport | null {
    return this.transport
  }

  /** Destroy the connection and clean up all resources */
  destroy(): void {
    this.destroyed = true
    this.removeNetworkListeners()
    this.disconnect()
    this.componentCallbacks.clear()
    this.unrouted.clear()
    this.binaryCallbacks.clear()
    this.roomBinaryHandlers.clear()
    for (const [, req] of this.pendingRequests) {
      clearTimeout(req.timeout)
      req.reject(new Error('Connection destroyed'))
    }
    this.pendingRequests.clear()
    this.uploadAliases.clear()
    this.stateListeners.clear()
  }
}
