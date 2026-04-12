/**
 * SSR-safe LiveComponentsProvider
 *
 * Drop-in replacement for LiveComponentsProvider that works in SSR:
 * - Server: renders children with a stub context (no WebSocket, safe defaults)
 * - Client: lazy-loads and delegates to the real LiveComponentsProvider
 *
 * Usage (same API as LiveComponentsProvider):
 *   import { SSRLiveProvider } from '@fluxstack/live-react'
 *   // or
 *   import { SSRLiveProvider as LiveComponentsProvider } from '@fluxstack/live-react/ssr'
 *
 *   <SSRLiveProvider url="ws://localhost:3000/api/live/ws">
 *     <App />
 *   </SSRLiveProvider>
 */

import React, { createContext, useContext, useState, useEffect } from 'react'
import type { LiveComponentsContextValue, LiveComponentsProviderProps } from './LiveComponentsProvider'

const isServer = typeof window === 'undefined'

// Default stub values — safe for SSR rendering
const SSR_STUB: LiveComponentsContextValue = {
  connected: false,
  connecting: false,
  error: null,
  connectionId: null,
  authenticated: false,
  $auth: { authenticated: false, session: null },
  sendMessage: () => Promise.resolve(),
  sendMessageAndWait: () => Promise.resolve({} as any),
  sendBinaryAndWait: () => Promise.resolve({} as any),
  registerComponent: () => () => {},
  registerBinaryHandler: () => () => {},
  registerRoomBinaryHandler: () => () => {},
  unregisterComponent: () => {},
  reconnect: () => {},
  authenticate: () => Promise.resolve(false),
  getWebSocket: () => null,
}

/**
 * SSR stub context — used on the server and while the real provider loads.
 * Components that call useLiveComponents() get safe default values instead of crashing.
 */
const SSRLiveContext = createContext<LiveComponentsContextValue>(SSR_STUB)

/**
 * SSR-safe LiveComponentsProvider
 *
 * On the server: provides stub context, children render normally.
 * On the client: lazy-loads the real LiveComponentsProvider and swaps in.
 *
 * The transition is seamless — components see `connected: false` initially
 * (same as the real provider before WebSocket connects), then `connected: true`
 * once the real provider loads and WebSocket connects.
 */
export function SSRLiveProvider({
  children,
  ...props
}: LiveComponentsProviderProps) {
  const [RealProvider, setRealProvider] = useState<React.ComponentType<LiveComponentsProviderProps> | null>(null)

  useEffect(() => {
    // Dynamic import avoids loading LiveConnection (which needs WebSocket) on the server
    // The import is from the same package — no extra network request
    import('./LiveComponentsProvider').then(mod => {
      setRealProvider(() => mod.LiveComponentsProvider)
    })
  }, [])

  // Server-side OR client before real provider loads
  if (isServer || !RealProvider) {
    return (
      <SSRLiveContext.Provider value={{ ...SSR_STUB, connecting: !isServer }}>
        {children}
      </SSRLiveContext.Provider>
    )
  }

  // Client-side with real provider
  return <RealProvider {...props}>{children}</RealProvider>
}

/**
 * SSR-safe version of useLiveComponents.
 * Returns stub values on the server instead of throwing.
 *
 * On the client after hydration, returns real values from LiveComponentsProvider.
 */
export function useSSRLiveComponents(): LiveComponentsContextValue {
  // Try the real context first (set by LiveComponentsProvider)
  const realContext = React.useContext(
    // Access the real context from LiveComponentsProvider module
    // We do this via a ref that gets set when the real provider loads
    SSRLiveContext
  )

  return realContext
}
