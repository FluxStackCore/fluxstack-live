// @fluxstack/live-client - WebSocket Connection Manager
//
// Framework-agnostic WebSocket connection with auto-reconnect, heartbeat,
// request-response pattern, and component message routing.

import type { WebSocketMessage, WebSocketResponse } from '@fluxstack/live'

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
 * Framework-agnostic WebSocket connection manager.
 * Handles reconnection, heartbeat, request-response pattern, and message routing.
 */
export class LiveConnection {
  private ws: WebSocket | null = null
  private options: Required<Omit<LiveConnectionOptions, 'url' | 'auth'>> & { url?: string; auth?: LiveAuthOptions }
  private reconnectAttempts = 0
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null
  private componentCallbacks = new Map<string, ComponentCallback>()
  private binaryCallbacks = new Map<string, (payload: Uint8Array) => void>()
  private roomBinaryHandlers = new Set<(frame: Uint8Array) => void>()
  private pendingRequests = new Map<string, {
    resolve: (value: any) => void
    reject: (error: any) => void
    timeout: ReturnType<typeof setTimeout>
  }>()
  private stateListeners = new Set<StateChangeCallback>()
  private _state: LiveConnectionState = {
    connected: false,
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
      autoConnect: options.autoConnect ?? true,
      reconnectInterval: options.reconnectInterval ?? 1000,
      maxReconnectAttempts: options.maxReconnectAttempts ?? 5,
      heartbeatInterval: options.heartbeatInterval ?? 30000,
      debug: options.debug ?? false,
    }

    if (this.options.autoConnect) {
      this.connect()
    }
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

  private getWebSocketUrl(): string {
    if (this.options.url) {
      return this.options.url
    } else if (typeof window === 'undefined') {
      return 'ws://localhost:3000/api/live/ws'
    } else {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      return `${protocol}//${window.location.host}/api/live/ws`
    }
  }

  private log(message: string, data?: any) {
    if (this.options.debug) {
      console.log(`[LiveConnection] ${message}`, data || '')
    }
  }

  /** Generate unique request ID */
  generateRequestId(): string {
    return `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  }

  /** Connect to WebSocket server */
  connect(): void {
    if (this.ws?.readyState === WebSocket.CONNECTING) {
      this.log('Already connecting, skipping...')
      return
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.log('Already connected, skipping...')
      return
    }

    this.setState({ connecting: true, error: null })
    const url = this.getWebSocketUrl()
    this.log('Connecting...', { url })

    try {
      const ws = new WebSocket(url)
      ws.binaryType = 'arraybuffer'
      this.ws = ws

      ws.onopen = () => {
        this.log('Connected')
        this.setState({ connected: true, connecting: false })
        this.reconnectAttempts = 0
        this.startHeartbeat()
      }

      ws.onmessage = (event) => {
        // Binary message path (BINARY_STATE_DELTA)
        if (event.data instanceof ArrayBuffer) {
          this.handleBinaryMessage(new Uint8Array(event.data))
          return
        }

        try {
          const parsed = JSON.parse(event.data)
          // Server may send batched messages as a JSON array
          if (Array.isArray(parsed)) {
            for (const msg of parsed) {
              this.log('Received', { type: msg.type, componentId: msg.componentId })
              this.handleMessage(msg)
            }
          } else {
            this.log('Received', { type: parsed.type, componentId: parsed.componentId })
            this.handleMessage(parsed)
          }
        } catch {
          this.log('Failed to parse message')
          this.setState({ error: 'Failed to parse message' })
        }
      }

      ws.onclose = (event) => {
        this.log('Disconnected', { code: event.code, reason: event.reason })
        this.setState({ connected: false, connecting: false, connectionId: null, authenticated: false, auth: { authenticated: false, session: null } })
        this.stopHeartbeat()

        // Server rejected connection due to CSRF origin validation — don't retry
        if (event.code === 4003) {
          this.setState({ error: 'Connection rejected: origin not allowed' })
          return
        }

        this.attemptReconnect()
      }

      ws.onerror = () => {
        this.log('WebSocket error')
        this.setState({ error: 'WebSocket connection error', connecting: false })
      }
    } catch (error) {
      this.setState({
        connecting: false,
        error: error instanceof Error ? error.message : 'Connection failed',
      })
    }
  }

  /** Disconnect from WebSocket server */
  disconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }
    this.stopHeartbeat()
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.reconnectAttempts = this.options.maxReconnectAttempts
    this.setState({ connected: false, connecting: false, connectionId: null })
  }

  /** Manual reconnect */
  reconnect(): void {
    this.disconnect()
    this.reconnectAttempts = 0
    setTimeout(() => this.connect(), 100)
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts < this.options.maxReconnectAttempts) {
      this.reconnectAttempts++
      this.log(`Reconnecting... (${this.reconnectAttempts}/${this.options.maxReconnectAttempts})`)
      this.reconnectTimeout = setTimeout(() => this.connect(), this.options.reconnectInterval)
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
      if (this.ws?.readyState === WebSocket.OPEN) {
        let failed = false
        for (const componentId of this.componentCallbacks.keys()) {
          this.sendMessage({
            type: 'COMPONENT_PING',
            componentId,
            timestamp: Date.now(),
          }).catch(() => { failed = true })
        }
        if (failed) {
          this.consecutiveHeartbeatFailures++
          this.log(`Heartbeat failed (${this.consecutiveHeartbeatFailures}/${LiveConnection.MAX_HEARTBEAT_FAILURES})`)
          if (this.consecutiveHeartbeatFailures >= LiveConnection.MAX_HEARTBEAT_FAILURES) {
            this.log('Too many heartbeat failures, reconnecting...')
            this.setState({ error: 'Heartbeat failed' })
            this.reconnect()
          }
        } else {
          this.consecutiveHeartbeatFailures = 0
        }
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
      this.setState({
        connectionId: response.connectionId || null,
        authenticated: (response as any).authenticated || false,
      })

      // Send AUTH message if credentials provided (always via socket, never in URL)
      const auth = this.options.auth
      if (auth && Object.keys(auth).some(k => auth[k])) {
        this.sendMessageAndWait({ type: 'AUTH', payload: auth } as any)
          .then(authResp => {
            const payload = (authResp as any).payload
            if (payload?.authenticated) {
              this.setState({
                authenticated: true,
                auth: { authenticated: true, session: payload.session || null },
              })
            }
          })
          .catch(() => {})
      }
    }

    // Handle auth response
    if (response.type === 'AUTH_RESPONSE') {
      const payload = (response as any).payload
      const authenticated = payload?.authenticated || false
      this.setState({
        authenticated,
        auth: {
          authenticated,
          session: authenticated ? (payload?.session || null) : null,
        },
      })
    }

    // Handle pending requests (request-response pattern)
    if (response.requestId && this.pendingRequests.has(response.requestId)) {
      const request = this.pendingRequests.get(response.requestId)!
      clearTimeout(request.timeout)
      this.pendingRequests.delete(response.requestId)

      if (response.success !== false) {
        request.resolve(response)
      } else {
        if (response.error?.includes?.('COMPONENT_REHYDRATION_REQUIRED')) {
          request.resolve(response)
        } else {
          request.reject(new Error(response.error || 'Request failed'))
        }
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
        this.log('No callback registered for component:', response.componentId)
      }
    }
  }

  /** Send message without waiting for response */
  async sendMessage(message: WebSocketMessage): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected')
    }
    const messageWithTimestamp = { ...message, timestamp: Date.now() }
    this.ws.send(JSON.stringify(messageWithTimestamp))
    this.log('Sent', { type: message.type, componentId: message.componentId })
  }

  /** Send message and wait for response */
  async sendMessageAndWait(message: WebSocketMessage, timeout = 10000): Promise<WebSocketResponse> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket is not connected'))
        return
      }

      const requestId = this.generateRequestId()

      const timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        reject(new Error(`Request timeout after ${timeout}ms`))
      }, timeout)

      this.pendingRequests.set(requestId, { resolve, reject, timeout: timeoutHandle })

      try {
        const messageWithRequestId = {
          ...message,
          requestId,
          expectResponse: true,
          timestamp: Date.now(),
        }
        this.ws.send(JSON.stringify(messageWithRequestId))
        this.log('Sent with requestId', { requestId, type: message.type })
      } catch (error) {
        clearTimeout(timeoutHandle)
        this.pendingRequests.delete(requestId)
        reject(error)
      }
    })
  }

  /** Send binary data and wait for response (for file uploads) */
  async sendBinaryAndWait(data: ArrayBuffer, requestId: string, timeout = 10000): Promise<WebSocketResponse> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket is not connected'))
        return
      }

      const timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        reject(new Error(`Binary request timeout after ${timeout}ms`))
      }, timeout)

      this.pendingRequests.set(requestId, { resolve, reject, timeout: timeoutHandle })

      try {
        this.ws.send(data)
        this.log('Sent binary', { requestId, size: data.byteLength })
      } catch (error) {
        clearTimeout(timeoutHandle)
        this.pendingRequests.delete(requestId)
        reject(error)
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
      const componentId = new TextDecoder().decode(buffer.subarray(2, 2 + idLen))
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
    return () => { this.roomBinaryHandlers.delete(callback) }
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
      const response = await this.sendMessageAndWait(
        { type: 'AUTH', payload: credentials } as any,
        5000
      )
      const payload = (response as any).payload
      const success = payload?.authenticated || false
      this.setState({
        authenticated: success,
        auth: {
          authenticated: success,
          session: success ? (payload?.session || null) : null,
        },
      })
      return success
    } catch {
      return false
    }
  }

  /** Get the raw WebSocket instance */
  getWebSocket(): WebSocket | null {
    return this.ws
  }

  /** Destroy the connection and clean up all resources */
  destroy(): void {
    this.disconnect()
    this.componentCallbacks.clear()
    this.binaryCallbacks.clear()
    this.roomBinaryHandlers.clear()
    for (const [, req] of this.pendingRequests) {
      clearTimeout(req.timeout)
      req.reject(new Error('Connection destroyed'))
    }
    this.pendingRequests.clear()
    this.stateListeners.clear()
  }
}
