// @fluxstack/live-react - LiveComponentsProvider
//
// React context provider wrapping LiveConnection for use by hooks.

import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react'
import { LiveConnection } from '@fluxstack/live-client'
import type { LiveAuthOptions, LiveConnectionOptions } from '@fluxstack/live-client'
import type { WebSocketMessage, WebSocketResponse } from '@fluxstack/live'

export interface LiveComponentsContextValue {
  connected: boolean
  connecting: boolean
  error: string | null
  connectionId: string | null
  authenticated: boolean

  sendMessage: (message: WebSocketMessage) => Promise<void>
  sendMessageAndWait: (message: WebSocketMessage, timeout?: number) => Promise<WebSocketResponse>
  sendBinaryAndWait: (data: ArrayBuffer, requestId: string, timeout?: number) => Promise<WebSocketResponse>
  registerComponent: (componentId: string, callback: (message: WebSocketResponse) => void) => () => void
  unregisterComponent: (componentId: string) => void
  reconnect: () => void
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
  const connectionRef = useRef<LiveConnection | null>(null)

  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connectionId, setConnectionId] = useState<string | null>(null)
  const [authenticated, setAuthenticated] = useState(false)

  // Create connection once
  if (!connectionRef.current) {
    connectionRef.current = new LiveConnection({
      url,
      auth,
      autoConnect: false, // We manage auto-connect via useEffect
      reconnectInterval,
      maxReconnectAttempts,
      heartbeatInterval,
      debug,
    })
  }

  const conn = connectionRef.current

  // Subscribe to state changes
  useEffect(() => {
    const unsub = conn.onStateChange((state) => {
      setConnected(state.connected)
      setConnecting(state.connecting)
      setError(state.error)
      setConnectionId(state.connectionId)
      setAuthenticated(state.authenticated)
    })

    if (autoConnect) {
      conn.connect()
    }

    return () => {
      unsub()
      conn.destroy()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const sendMessage = useCallback(async (message: WebSocketMessage) => {
    return conn.sendMessage(message)
  }, [conn])

  const sendMessageAndWait = useCallback(async (message: WebSocketMessage, timeout?: number) => {
    return conn.sendMessageAndWait(message, timeout)
  }, [conn])

  const sendBinaryAndWait = useCallback(async (data: ArrayBuffer, requestId: string, timeout?: number) => {
    return conn.sendBinaryAndWait(data, requestId, timeout)
  }, [conn])

  const registerComponent = useCallback((componentId: string, callback: (message: WebSocketResponse) => void) => {
    return conn.registerComponent(componentId, callback)
  }, [conn])

  const unregisterComponent = useCallback((componentId: string) => {
    conn.unregisterComponent(componentId)
  }, [conn])

  const reconnect = useCallback(() => {
    conn.reconnect()
  }, [conn])

  const authenticate = useCallback(async (credentials: LiveAuthOptions) => {
    return conn.authenticate(credentials)
  }, [conn])

  const getWebSocket = useCallback(() => {
    return conn.getWebSocket()
  }, [conn])

  const value: LiveComponentsContextValue = {
    connected,
    connecting,
    error,
    connectionId,
    authenticated,
    sendMessage,
    sendMessageAndWait,
    sendBinaryAndWait,
    registerComponent,
    unregisterComponent,
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
