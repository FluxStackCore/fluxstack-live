// @fluxstack/live-react - LiveComponentsProvider
//
// React context provider wrapping LiveConnection for use by hooks.
// SSR-safe: connection is created in useEffect (client-only), not during render.

import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react'
import type { LiveAuthOptions, LiveConnectionOptions, LiveClientAuth } from '@fluxstack/live-client'
import type { WebSocketMessage, WebSocketResponse } from '@fluxstack/live'

export interface LiveComponentsContextValue {
  connected: boolean
  connecting: boolean
  error: string | null
  connectionId: string | null
  authenticated: boolean
  /** Auth context with session data from the server */
  $auth: LiveClientAuth
  sendMessage: (message: WebSocketMessage) => Promise<void>
  sendMessageAndWait: (message: WebSocketMessage, timeout?: number) => Promise<WebSocketResponse>
  sendBinaryAndWait: (data: ArrayBuffer, requestId: string, timeout?: number) => Promise<WebSocketResponse>
  registerComponent: (componentId: string, callback: (message: WebSocketResponse) => void) => () => void
  registerBinaryHandler: (componentId: string, callback: (payload: Uint8Array) => void) => () => void
  registerRoomBinaryHandler: (callback: (frame: Uint8Array) => void) => () => void
  unregisterComponent: (componentId: string) => void
  /** Manually initiate the WebSocket connection (useful with autoConnect: false) */
  connect: () => void
  /** Disconnect and reconnect the WebSocket */
  reconnect: () => void
  /** Disconnect the WebSocket */
  disconnect: () => void
  authenticate: (credentials: LiveAuthOptions) => Promise<boolean>
  getWebSocket: () => WebSocket | null
}

const LiveComponentsContext = createContext<LiveComponentsContextValue | null>(null)

export interface LiveComponentsProviderProps extends Omit<LiveConnectionOptions, 'autoConnect'> {
  children: React.ReactNode
  autoConnect?: boolean
}

export function LiveComponentsProvider({
  children,
  url,
  auth,
  autoConnect = true,
  reconnectInterval = 1000,
  maxReconnectAttempts = 5,
  heartbeatInterval = 30000,
  debug = false,
}: LiveComponentsProviderProps) {
  const connectionRef = useRef<import('@fluxstack/live-client').LiveConnection | null>(null)

  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connectionId, setConnectionId] = useState<string | null>(null)
  const [authenticated, setAuthenticated] = useState(false)
  const [$auth, set$auth] = useState<LiveClientAuth>({ authenticated: false, session: null })

  // Create connection in useEffect — SSR-safe (useEffect is skipped on the server)
  useEffect(() => {
    // Dynamic import to avoid loading LiveConnection module at SSR import time
    import('@fluxstack/live-client').then(({ LiveConnection }) => {
      const conn = new LiveConnection({
        url,
        auth,
        autoConnect: false,
        reconnectInterval,
        maxReconnectAttempts,
        heartbeatInterval,
        debug,
      })

      connectionRef.current = conn

      const unsub = conn.onStateChange((state) => {
        setConnected(state.connected)
        setConnecting(state.connecting)
        setError(state.error)
        setConnectionId(state.connectionId)
        setAuthenticated(state.authenticated)
        set$auth(state.auth)
      })

      if (autoConnect) {
        // Wait for DOM to be fully loaded before connecting.
        // This prevents the WS handshake from competing with
        // initial resource loading (scripts, styles, images).
        if (typeof document !== 'undefined' && document.readyState === 'complete') {
          conn.connect()
        } else if (typeof window !== 'undefined') {
          const onReady = () => conn.connect()
          window.addEventListener('load', onReady, { once: true })
          ;(connectionRef as any).__loadCleanup = () => window.removeEventListener('load', onReady)
        } else {
          conn.connect()
        }
      }

      // Cleanup stored for unmount
      ;(connectionRef as any).__unsub = unsub
    })

    return () => {
      const unsub = (connectionRef as any).__unsub
      if (unsub) unsub()
      const loadCleanup = (connectionRef as any).__loadCleanup
      if (loadCleanup) loadCleanup()
      if (connectionRef.current) {
        connectionRef.current.disconnect()
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Helper to get current connection (may be null during SSR or before useEffect runs)
  const getConn = () => connectionRef.current

  const sendMessage = useCallback(async (message: WebSocketMessage) => {
    const conn = getConn()
    if (!conn) throw new Error('Not connected')
    return conn.sendMessage(message)
  }, [])

  const sendMessageAndWait = useCallback(async (message: WebSocketMessage, timeout?: number) => {
    const conn = getConn()
    if (!conn) throw new Error('Not connected')
    return conn.sendMessageAndWait(message, timeout)
  }, [])

  const sendBinaryAndWait = useCallback(async (data: ArrayBuffer, requestId: string, timeout?: number) => {
    const conn = getConn()
    if (!conn) throw new Error('Not connected')
    return conn.sendBinaryAndWait(data, requestId, timeout)
  }, [])

  const registerComponent = useCallback((componentId: string, callback: (message: WebSocketResponse) => void) => {
    const conn = getConn()
    if (!conn) return () => {}
    return conn.registerComponent(componentId, callback)
  }, [])

  const registerBinaryHandler = useCallback((componentId: string, callback: (payload: Uint8Array) => void) => {
    const conn = getConn()
    if (!conn) return () => {}
    return conn.registerBinaryHandler(componentId, callback)
  }, [])

  const registerRoomBinaryHandler = useCallback((callback: (frame: Uint8Array) => void) => {
    const conn = getConn()
    if (!conn) return () => {}
    return conn.registerRoomBinaryHandler(callback)
  }, [])

  const unregisterComponent = useCallback((componentId: string) => {
    const conn = getConn()
    if (conn) conn.unregisterComponent(componentId)
  }, [])

  const connect = useCallback(() => {
    const conn = getConn()
    if (conn) conn.connect()
  }, [])

  const disconnect = useCallback(() => {
    const conn = getConn()
    if (conn) conn.disconnect()
  }, [])

  const reconnect = useCallback(() => {
    const conn = getConn()
    if (conn) conn.reconnect()
  }, [])

  const authenticate = useCallback(async (credentials: LiveAuthOptions) => {
    const conn = getConn()
    if (!conn) return false
    return conn.authenticate(credentials)
  }, [])

  const getWebSocket = useCallback(() => {
    const conn = getConn()
    return conn?.getWebSocket() ?? null
  }, [])

  const value: LiveComponentsContextValue = {
    connected,
    connecting,
    error,
    connectionId,
    authenticated,
    $auth,
    sendMessage,
    sendMessageAndWait,
    sendBinaryAndWait,
    registerComponent,
    registerBinaryHandler,
    registerRoomBinaryHandler,
    unregisterComponent,
    connect,
    disconnect,
    reconnect,
    authenticate,
    getWebSocket,
  }

  return (
    <LiveComponentsContext.Provider value={value}>
      {children}
    </LiveComponentsContext.Provider>
  )
}

/** Hook to access the LiveComponents context */
export function useLiveComponents(): LiveComponentsContextValue {
  const context = useContext(LiveComponentsContext)
  if (!context) {
    throw new Error('useLiveComponents must be used within LiveComponentsProvider')
  }
  return context
}
