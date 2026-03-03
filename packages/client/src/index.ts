// @fluxstack/live-client - Framework-agnostic browser client
//
// This package provides the core WebSocket connection, room management,
// file upload, state persistence, and validation utilities.
// It has NO dependency on any UI framework (React, Vue, etc.).
//
// Quick start (browser IIFE):
//   const counter = FluxstackLive.useLive('Counter', { count: 0 })
//   counter.on(state => document.getElementById('count').textContent = state.count)
//   counter.call('increment')

// Connection
export { LiveConnection } from './connection'
export type {
  LiveAuthOptions,
  LiveConnectionOptions,
  LiveConnectionState,
} from './connection'

// Component Handle (vanilla JS equivalent of Live.use)
export { LiveComponentHandle } from './component'
export type { LiveComponentOptions } from './component'

// Rooms
export { RoomManager } from './rooms'
export type {
  RoomClientMessage,
  RoomServerMessage,
  RoomHandle,
  RoomProxy,
  RoomManagerOptions,
  EventHandler,
  Unsubscribe,
} from './rooms'

// Upload
export {
  AdaptiveChunkSizer,
  ChunkedUploader,
  createBinaryChunkMessage,
} from './upload'
export type {
  AdaptiveChunkConfig,
  ChunkMetrics,
  ChunkedUploadOptions,
  ChunkedUploadState,
} from './upload'

// Persistence
export {
  persistState,
  getPersistedState,
  clearPersistedState,
} from './persistence'
export type { PersistedState } from './persistence'

// State Validation
export { StateValidator } from './state-validator'
export type {
  StateValidation,
  StateConflict,
  HybridState,
} from './state-validator'

// ===== useLive — simplified API for vanilla JS =====

import { LiveConnection } from './connection'
import type { LiveConnectionOptions } from './connection'
import { LiveComponentHandle } from './component'
import type { LiveComponentOptions } from './component'

/** Shared connection singleton — created once, reused by all useLive() calls */
let _sharedConnection: LiveConnection | null = null
let _sharedConnectionUrl: string | null = null

/** Status listeners for the shared connection */
type ConnectionStatusCallback = (connected: boolean) => void
const _statusListeners = new Set<ConnectionStatusCallback>()

function getOrCreateConnection(url?: string): LiveConnection {
  const resolvedUrl = url ?? `ws://${typeof location !== 'undefined' ? location.host : 'localhost:3000'}/api/live/ws`

  // Reuse existing connection if same URL
  if (_sharedConnection && _sharedConnectionUrl === resolvedUrl) {
    return _sharedConnection
  }

  // Destroy old connection if URL changed
  if (_sharedConnection) {
    _sharedConnection.destroy()
  }

  _sharedConnection = new LiveConnection({ url: resolvedUrl })
  _sharedConnectionUrl = resolvedUrl

  _sharedConnection.onStateChange((state) => {
    for (const cb of _statusListeners) {
      cb(state.connected)
    }
  })

  return _sharedConnection
}

export interface UseLiveOptions {
  /** WebSocket URL. Auto-detected from window.location if omitted. */
  url?: string
  /** Room to join on mount */
  room?: string
  /** User ID for component isolation */
  userId?: string
  /** Auto-mount when connected. Default: true */
  autoMount?: boolean
  /** Enable debug logging. Default: false */
  debug?: boolean
}

export interface UseLiveHandle<TState extends Record<string, any> = Record<string, any>> {
  /** Call a server action */
  call: <R = any>(action: string, payload?: Record<string, any>) => Promise<R>
  /** Subscribe to state changes. Returns unsubscribe function. */
  on: (callback: (state: TState, delta: Partial<TState> | null) => void) => () => void
  /** Subscribe to errors. Returns unsubscribe function. */
  onError: (callback: (error: string) => void) => () => void
  /** Current state (read-only snapshot) */
  readonly state: Readonly<TState>
  /** Whether the component is mounted on the server */
  readonly mounted: boolean
  /** Server-assigned component ID */
  readonly componentId: string | null
  /** Last error message */
  readonly error: string | null
  /** Destroy the component and clean up */
  destroy: () => void
  /** Access the underlying LiveComponentHandle */
  readonly handle: LiveComponentHandle<TState>
}

/**
 * Create a live component with minimal boilerplate.
 * Manages the WebSocket connection automatically (singleton).
 *
 * @example Browser IIFE
 * ```html
 * <script src="/live-client.js"></script>
 * <script>
 *   const counter = FluxstackLive.useLive('Counter', { count: 0 })
 *   counter.on(state => {
 *     document.getElementById('count').textContent = state.count
 *   })
 *   document.querySelector('.inc').onclick = () => counter.call('increment')
 * </script>
 * ```
 *
 * @example ES modules
 * ```ts
 * import { useLive } from '@fluxstack/live-client'
 * const counter = useLive('Counter', { count: 0 }, { url: 'ws://localhost:3000/api/live/ws' })
 * counter.on(state => console.log(state.count))
 * counter.call('increment')
 * ```
 */
export function useLive<TState extends Record<string, any> = Record<string, any>>(
  componentName: string,
  initialState: TState,
  options: UseLiveOptions = {},
): UseLiveHandle<TState> {
  const { url, room, userId, autoMount = true, debug = false } = options

  const connection = getOrCreateConnection(url)
  const handle = new LiveComponentHandle<TState>(connection, componentName, {
    initialState,
    room,
    userId,
    autoMount,
    debug,
  })

  return {
    call: (action, payload) => handle.call(action, payload ?? {}),
    on: (callback) => handle.onStateChange(callback),
    onError: (callback) => handle.onError(callback),
    get state() { return handle.state },
    get mounted() { return handle.mounted },
    get componentId() { return handle.componentId },
    get error() { return handle.error },
    destroy: () => handle.destroy(),
    handle,
  }
}

/**
 * Subscribe to the shared connection status (connected/disconnected).
 * Useful for showing a global status indicator.
 *
 * @example
 * ```js
 * FluxstackLive.onConnectionChange(connected => {
 *   statusEl.textContent = connected ? 'Connected' : 'Disconnected'
 * })
 * ```
 */
export function onConnectionChange(callback: ConnectionStatusCallback): () => void {
  _statusListeners.add(callback)
  // Immediately fire with current state if connection exists
  if (_sharedConnection) {
    callback(_sharedConnection.state.connected)
  }
  return () => { _statusListeners.delete(callback) }
}

/**
 * Get or create the shared connection instance.
 * Useful when you need direct access to the connection.
 */
export function getConnection(url?: string): LiveConnection {
  return getOrCreateConnection(url)
}
