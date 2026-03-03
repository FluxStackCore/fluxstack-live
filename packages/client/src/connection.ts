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

export interface LiveConnectionState {
  connected: boolean
  connecting: boolean
  error: string | null
  connectionId: string | null
  authenticated: boolean
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
    const auth = this.options.auth
    let baseUrl: string

    if (this.options.url) {
      baseUrl = this.options.url
    } else if (typeof window === 'undefined') {
      baseUrl = 'ws://localhost:3000/api/live/ws'
    } else {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      baseUrl = `${protocol}//${window.location.host}/api/live/ws`
    }

    if (auth?.token) {
      const separator = baseUrl.includes('?') ? '&' : '?'
      return `${baseUrl}${separator}token=${encodeURIComponent(auth.token)}`
    }

    return baseUrl
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
      this.ws = ws

      ws.onopen = () => {
        this.log('Connected')
        this.setState({ connected: true, connecting: false })
        this.reconnectAttempts = 0
        this.startHeartbeat()
      }

      ws.onmessage = (event) => {
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

      ws.onclose = () => {
        this.log('Disconnected')
        this.setState({ connected: false, connecting: false, connectionId: null })
        this.stopHeartbeat()
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

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        for (const componentId of this.componentCallbacks.keys()) {
          this.sendMessage({
            type: 'COMPONENT_PING',
            componentId,
            timestamp: Date.now(),
          }).catch(() => {})
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

      // If auth credentials provided but not via token query, send AUTH message
      const auth = this.options.auth
      if (auth && !auth.token && Object.keys(auth).some(k => auth[k])) {
        this.sendMessageAndWait({ type: 'AUTH', payload: auth } as any)
          .then(authResp => {
            if ((authResp as any).authenticated) {
              this.setState({ authenticated: true })
            }
          })
          .catch(() => {})
      }
    }

    // Handle auth response
    if (response.type === 'AUTH_RESPONSE') {
      this.setState({ authenticated: (response as any).authenticated || false })
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
      const success = (response as any).authenticated || false
      this.setState({ authenticated: success })
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
    for (const [, req] of this.pendingRequests) {
      clearTimeout(req.timeout)
      req.reject(new Error('Connection destroyed'))
    }
    this.pendingRequests.clear()
    this.stateListeners.clear()
  }
}
