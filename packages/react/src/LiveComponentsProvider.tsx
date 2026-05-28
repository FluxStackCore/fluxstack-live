'use client'
// @fluxstack/live-react - LiveComponentsProvider
//
// React context provider wrapping LiveConnection for use by hooks.
// SSR-safe: connection is created in useEffect (client-only), not during render.
//
// 'use client': marca este módulo como client boundary. Necessário para RSC —
// usa createContext/hooks que não existem no ambiente react-server. Sem isto,
// importar o Provider (mesmo indiretamente) num server component quebra com
// "createContext is not a function".

import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react'
import type { LiveAuthOptions, LiveConnectionOptions, LiveClientAuth } from '@fluxstack/live-client'
import type { WebSocketMessage, WebSocketResponse } from '@fluxstack/live'
import { acquire as poolAcquire, release as poolRelease, poolKey } from './connectionPool'

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
  // Pending registrations captured before the async LiveConnection import resolves.
  // Drained once connectionRef.current is set. Without this, any handler
  // registered synchronously in a child useEffect during the first render gets
  // silently dropped (the early-return `() => {}` stub), and frames arriving
  // later go nowhere — which manifests as "chat handler never fires".
  const pendingRoomBinaryHandlersRef = useRef<Set<(frame: Uint8Array) => void>>(new Set())
  const pendingRoomBinaryUnsubsRef = useRef<Map<(frame: Uint8Array) => void, () => void>>(new Map())

  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connectionId, setConnectionId] = useState<string | null>(null)
  const [authenticated, setAuthenticated] = useState(false)
  const [$auth, set$auth] = useState<LiveClientAuth>({ authenticated: false, session: null })

  // Create connection in useEffect — SSR-safe (useEffect is skipped on the server)
  useEffect(() => {
    // `cancelled` guards the async import: if the effect cleanup runs before
    // the dynamic import resolves (React Strict Mode double-invoke, or fast
    // unmount), we must not create the connection at all. Otherwise the
    // unmount's disconnect() runs against a null ref and leaks the socket.
    let cancelled = false
    let localConn: import('@fluxstack/live-client').LiveConnection | null = null
    let localUnsub: (() => void) | null = null
    let localLoadCleanup: (() => void) | null = null

    const key = poolKey({ url, auth })
    let acquired = false

    import('@fluxstack/live-client').then(({ LiveConnection }) => {
      if (cancelled) return

      // Pool the connection so React StrictMode's mount → unmount → remount
      // cycle reuses the same socket instead of opening two simultaneous
      // handshakes (#34). The pool keeps the connection alive for a short
      // grace window after release(), which covers StrictMode's sequential
      // remount.
      const conn = poolAcquire(key, () => new LiveConnection({
        url,
        auth,
        autoConnect: false,
        reconnectInterval,
        maxReconnectAttempts,
        heartbeatInterval,
        debug,
      }))
      acquired = true

      localConn = conn
      connectionRef.current = conn

      // Drain any handlers registered before the connection existed.
      // Each pending handler is subscribed now and its real unsub stored so
      // a future call to the stub unsub performs the actual cleanup.
      for (const handler of pendingRoomBinaryHandlersRef.current) {
        const realUnsub = conn.registerRoomBinaryHandler(handler)
        pendingRoomBinaryUnsubsRef.current.set(handler, realUnsub)
      }

      const applyState = (state: typeof conn.state) => {
        setConnected(state.connected)
        setConnecting(state.connecting)
        setError(state.error)
        setConnectionId(state.connectionId)
        setAuthenticated(state.authenticated)
        set$auth(state.auth)
      }
      localUnsub = conn.onStateChange(applyState)
      // Sincroniza o estado ATUAL imediatamente: ao adquirir uma conexão do pool
      // que JÁ está conectada (ex: troca de página com keep-alive), onStateChange
      // só dispara em mudanças futuras — sem isto o novo Provider ficaria preso
      // em "Offline" mesmo com a conexão ativa.
      applyState(conn.state)

      if (autoConnect) {
        // Wait for DOM to be fully loaded before connecting.
        // This prevents the WS handshake from competing with
        // initial resource loading (scripts, styles, images).
        // Calling connect() on an already-connected pooled connection is a
        // no-op (LiveConnection guards readyState), so this is safe to run
        // for every acquire().
        if (typeof document !== 'undefined' && document.readyState === 'complete') {
          conn.connect()
        } else if (typeof window !== 'undefined') {
          const onReady = () => conn.connect()
          window.addEventListener('load', onReady, { once: true })
          localLoadCleanup = () => window.removeEventListener('load', onReady)
        } else {
          conn.connect()
        }
      }
    })

    return () => {
      cancelled = true
      if (localUnsub) localUnsub()
      if (localLoadCleanup) localLoadCleanup()
      // Release the pooled connection. The pool handles the actual
      // disconnect after a short grace window — see connectionPool.ts.
      if (acquired) poolRelease(key)
      if (connectionRef.current === localConn) connectionRef.current = null
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
    if (conn) return conn.registerRoomBinaryHandler(callback)
    // Connection not yet created (async dynamic import pending). Queue the
    // handler so it gets subscribed once the connection is available, and
    // return an unsub that handles both the queued and post-drain states.
    pendingRoomBinaryHandlersRef.current.add(callback)
    return () => {
      pendingRoomBinaryHandlersRef.current.delete(callback)
      const realUnsub = pendingRoomBinaryUnsubsRef.current.get(callback)
      if (realUnsub) {
        realUnsub()
        pendingRoomBinaryUnsubsRef.current.delete(callback)
      }
    }
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

/**
 * Contexto inerte usado no SSR quando não há Provider. Permite que Live.use()
 * renderize no servidor como placeholder (estado inicial, desconectado, actions
 * no-op) em vez de quebrar — base do "SSR de brinde": o dev escreve Live.use()
 * normal e o componente vira placeholder no server, montando/conectando só no
 * client. NÃO é usado no browser (lá a ausência de Provider continua sendo erro).
 */
const SSR_NOOP_CONTEXT: LiveComponentsContextValue = {
  connected: false,
  connecting: false,
  error: null,
  connectionId: null,
  authenticated: false,
  $auth: { authenticated: false, session: null },
  sendMessage: async () => {},
  sendMessageAndWait: async () => ({ success: false }) as WebSocketResponse,
  sendBinaryAndWait: async () => ({ success: false }) as WebSocketResponse,
  registerComponent: () => () => {},
  registerBinaryHandler: () => () => {},
  registerRoomBinaryHandler: () => () => {},
  unregisterComponent: () => {},
  connect: () => {},
  reconnect: () => {},
  disconnect: () => {},
  authenticate: async () => false,
  getWebSocket: () => null,
}

/** Hook to access the LiveComponents context */
export function useLiveComponents(): LiveComponentsContextValue {
  const context = useContext(LiveComponentsContext)
  if (!context) {
    // SSR sem Provider: devolve contexto inerte (placeholder), não quebra.
    // No browser, Provider ausente continua sendo erro de programação.
    if (typeof window === 'undefined') return SSR_NOOP_CONTEXT
    throw new Error('useLiveComponents must be used within LiveComponentsProvider')
  }
  return context
}
