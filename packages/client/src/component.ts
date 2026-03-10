// @fluxstack/live-client - LiveComponentHandle
//
// High-level vanilla JS wrapper for live components.
// Equivalent to Live.use() in @fluxstack/live-react but without React.
//
// Usage:
//   const connection = new LiveConnection({ url: 'ws://...' })
//   const counter = new LiveComponentHandle(connection, 'Counter', { count: 0 })
//   counter.onStateChange((state) => updateUI(state))
//   await counter.mount()
//   await counter.call('increment')

import type { WebSocketResponse } from '@fluxstack/live'
import type { LiveConnection } from './connection'

// ===== Deep Merge (always-on, retrocompatible) =====

function isPlainObject(v: unknown): v is Record<string, any> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    && Object.getPrototypeOf(v) === Object.prototype
}

function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>, seen?: Set<object>): T {
  if (!seen) seen = new Set()
  if (seen.has(source as object)) return target
  seen.add(source as object)

  const result = { ...target }
  for (const key of Object.keys(source) as Array<keyof T>) {
    const newVal = source[key]
    const oldVal = result[key]
    if (isPlainObject(oldVal) && isPlainObject(newVal)) {
      result[key] = deepMerge(oldVal as any, newVal as any, seen)
    } else {
      result[key] = newVal as T[keyof T]
    }
  }
  return result
}

export interface LiveComponentOptions<TState = Record<string, any>> {
  /** Initial state to merge with server defaults */
  initialState?: Partial<TState>
  /** Room to join on mount */
  room?: string
  /** User ID for component isolation */
  userId?: string
  /** Auto-mount when connection is ready. Default: true */
  autoMount?: boolean
  /** Enable debug logging. Default: false */
  debug?: boolean
}

type StateChangeCallback<TState> = (state: TState, delta: Partial<TState> | null) => void
type ErrorCallback = (error: string) => void

/**
 * High-level handle for a live component instance.
 * Manages mount lifecycle, state sync, and action calling.
 * Framework-agnostic — works with vanilla JS, Vue, Svelte, etc.
 */
export class LiveComponentHandle<TState extends Record<string, any> = Record<string, any>> {
  private connection: LiveConnection
  private componentName: string
  private options: Required<Omit<LiveComponentOptions<TState>, 'initialState' | 'room' | 'userId'>> & {
    initialState: Partial<TState>
    room?: string
    userId?: string
  }

  private _componentId: string | null = null
  private _state: TState
  private _mounted = false
  private _mounting = false
  private _error: string | null = null

  private stateListeners = new Set<StateChangeCallback<TState>>()
  private errorListeners = new Set<ErrorCallback>()
  private unregisterComponent: (() => void) | null = null
  private unsubConnection: (() => void) | null = null

  constructor(
    connection: LiveConnection,
    componentName: string,
    options: LiveComponentOptions<TState> = {},
  ) {
    this.connection = connection
    this.componentName = componentName
    this._state = (options.initialState ?? {}) as TState

    this.options = {
      initialState: options.initialState ?? {},
      room: options.room,
      userId: options.userId,
      autoMount: options.autoMount ?? true,
      debug: options.debug ?? false,
    }

    // Auto-mount when connection is ready
    if (this.options.autoMount) {
      if (this.connection.state.connected) {
        this.mount()
      }
      this.unsubConnection = this.connection.onStateChange((connState) => {
        if (connState.connected && !this._mounted && !this._mounting) {
          this.mount()
        }
      })
    }
  }

  // ── Getters ──

  /** Current component state */
  get state(): Readonly<TState> { return this._state }

  /** Server-assigned component ID (null before mount) */
  get componentId(): string | null { return this._componentId }

  /** Whether the component has been mounted */
  get mounted(): boolean { return this._mounted }

  /** Whether the component is currently mounting */
  get mounting(): boolean { return this._mounting }

  /** Last error message */
  get error(): string | null { return this._error }

  // ── Lifecycle ──

  /** Mount the component on the server */
  async mount(): Promise<void> {
    if (this._mounted || this._mounting) return
    if (!this.connection.state.connected) {
      throw new Error('Cannot mount: not connected')
    }

    this._mounting = true
    this._error = null
    this.log('Mounting...')

    try {
      const response = await this.connection.sendMessageAndWait({
        type: 'COMPONENT_MOUNT',
        componentId: `mount-${this.componentName}`,
        payload: {
          component: this.componentName,
          props: this.options.initialState,
          room: this.options.room,
          userId: this.options.userId,
        },
      })

      if (!response.success) {
        throw new Error(response.error || 'Mount failed')
      }

      const result = (response as any).result
      this._componentId = result.componentId
      this._mounted = true
      this._mounting = false

      // Merge initial state from server
      const serverState = result.initialState || {}
      this._state = { ...this._state, ...serverState }

      // Register for component messages (state updates, deltas, errors)
      this.unregisterComponent = this.connection.registerComponent(
        this._componentId!,
        (msg) => this.handleServerMessage(msg),
      )

      this.log('Mounted', { componentId: this._componentId })
      this.notifyStateChange(this._state, null)
    } catch (err) {
      this._mounting = false
      const errorMsg = err instanceof Error ? err.message : String(err)
      this._error = errorMsg
      this.notifyError(errorMsg)
      throw err
    }
  }

  /** Unmount the component from the server */
  async unmount(): Promise<void> {
    if (!this._mounted || !this._componentId) return

    this.log('Unmounting...')

    try {
      await this.connection.sendMessage({
        type: 'COMPONENT_UNMOUNT',
        componentId: this._componentId,
      })
    } catch {
      // Ignore unmount errors (connection may already be closed)
    }

    this.cleanup()
  }

  /** Destroy the handle and clean up all resources */
  destroy(): void {
    this.unmount().catch(() => {})
    if (this.unsubConnection) {
      this.unsubConnection()
      this.unsubConnection = null
    }
    this.stateListeners.clear()
    this.errorListeners.clear()
  }

  // ── Actions ──

  /**
   * Call an action on the server component.
   * Returns the action's return value.
   */
  async call<R = any>(action: string, payload: Record<string, any> = {}): Promise<R> {
    if (!this._mounted || !this._componentId) {
      throw new Error(`Cannot call '${action}': component not mounted`)
    }

    this.log(`Calling action: ${action}`, payload)

    const response = await this.connection.sendMessageAndWait({
      type: 'CALL_ACTION',
      componentId: this._componentId,
      action,
      payload,
    })

    if (!response.success) {
      const errorMsg = response.error || `Action '${action}' failed`
      this._error = errorMsg
      this.notifyError(errorMsg)
      throw new Error(errorMsg)
    }

    return (response as any).result
  }

  /**
   * Fire an action without waiting for a response (fire-and-forget).
   * Useful for high-frequency operations like game input where the
   * server doesn't need to send back a result.
   */
  fire(action: string, payload: Record<string, any> = {}): void {
    if (!this._mounted || !this._componentId) return

    this.connection.sendMessage({
      type: 'CALL_ACTION',
      componentId: this._componentId,
      action,
      payload,
      expectResponse: false,
    } as any)
  }

  // ── State ──

  /**
   * Subscribe to state changes.
   * Callback receives the full new state and the delta (or null for full updates).
   * Returns an unsubscribe function.
   */
  onStateChange(callback: StateChangeCallback<TState>): () => void {
    this.stateListeners.add(callback)
    return () => { this.stateListeners.delete(callback) }
  }

  /**
   * Register a binary decoder for this component.
   * When the server sends a BINARY_STATE_DELTA frame targeting this component,
   * the decoder converts the raw payload into a delta object which is merged into state.
   * Returns an unsubscribe function.
   */
  setBinaryDecoder(decoder: (buffer: Uint8Array) => Record<string, any>): () => void {
    if (!this._componentId) {
      throw new Error('Component must be mounted before setting binary decoder')
    }

    return this.connection.registerBinaryHandler(this._componentId, (payload: Uint8Array) => {
      try {
        const delta = decoder(payload) as Partial<TState>
        this._state = deepMerge(this._state, delta) as TState
        this.notifyStateChange(this._state, delta as Partial<TState>)
      } catch (e) {
        console.error('Binary decode error:', e)
      }
    })
  }

  /**
   * Subscribe to errors.
   * Returns an unsubscribe function.
   */
  onError(callback: ErrorCallback): () => void {
    this.errorListeners.add(callback)
    return () => { this.errorListeners.delete(callback) }
  }

  // ── Internal ──

  private handleServerMessage(msg: WebSocketResponse): void {
    switch (msg.type) {
      case 'STATE_UPDATE': {
        const newState = (msg as any).payload?.state
        if (newState) {
          this._state = deepMerge(this._state, newState)
          this.notifyStateChange(this._state, null)
        }
        break
      }

      case 'STATE_DELTA': {
        const delta = (msg as any).payload?.delta
        if (delta) {
          this._state = deepMerge(this._state, delta)
          this.notifyStateChange(this._state, delta)
        }
        break
      }

      case 'ERROR': {
        const error = (msg as any).error || 'Unknown error'
        this._error = error
        this.notifyError(error)
        break
      }

      default:
        this.log('Unhandled message type:', msg.type)
    }
  }

  private notifyStateChange(state: TState, delta: Partial<TState> | null): void {
    for (const cb of this.stateListeners) {
      cb(state, delta)
    }
  }

  private notifyError(error: string): void {
    for (const cb of this.errorListeners) {
      cb(error)
    }
  }

  private cleanup(): void {
    if (this.unregisterComponent) {
      this.unregisterComponent()
      this.unregisterComponent = null
    }
    this._componentId = null
    this._mounted = false
    this._mounting = false
  }

  private log(message: string, data?: any): void {
    if (this.options.debug) {
      console.log(`[Live:${this.componentName}] ${message}`, data ?? '')
    }
  }
}
