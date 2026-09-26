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

import type { SignedState, WebSocketResponse } from '@fluxstack/live'
import type { LiveConnection } from './connection'
import {
  clientMessages,
  readErrorMessage,
  readMountResult,
  readStateDelta,
  readStateSignature,
  readStateUpdate,
  toRecord,
} from './protocol'

// ===== Deep Merge (always-on, retrocompatible) =====

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    && Object.getPrototypeOf(v) === Object.prototype
}

/**
 * Apply a STATE_DELTA coming from the server (component state).
 *
 * Semantics (matches core's `deepAssign`, fixes #6):
 * - Top-level `null` is a real value (set to null).
 * - Nested `null` is the deletion sentinel from `computeDeepDiff`.
 * - `undefined` is skipped — it never crosses the wire.
 */
function deepMerge<T extends object>(target: T, source: object, seen?: Set<object>): T {
  // Deltas do servidor trazem chaves do próprio estado: o resultado mantém o tipo do alvo.
  return deepMergeImpl(toRecord(target), toRecord(source), 0, seen) as T
}

function deepMergeImpl(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  depth: number,
  seen?: Set<object>,
): Record<string, unknown> {
  if (!seen) seen = new Set()
  if (seen.has(source)) return target
  seen.add(source)

  const result: Record<string, unknown> = { ...target }
  for (const key of Object.keys(source)) {
    const newVal = source[key]
    if (newVal === undefined) continue
    if (newVal === null) {
      if (depth === 0) {
        result[key] = null
      } else {
        delete result[key]
      }
      continue
    }
    const oldVal = result[key]
    if (isPlainObject(oldVal) && isPlainObject(newVal)) {
      result[key] = deepMergeImpl(oldVal, newVal, depth + 1, seen)
    } else {
      result[key] = newVal
    }
  }
  return result
}

export interface LiveComponentOptions<TState extends object = Record<string, unknown>> {
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
export class LiveComponentHandle<TState extends object = Record<string, unknown>> {
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
  private _signedState: SignedState | null = null

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

  /**
   * signedState mais recente emitido pelo servidor (mount, STATE_UPDATE ou a
   * renovação throttled `STATE_SIGNATURE`). É o que se deve persistir e reenviar
   * num `clientMessages.rehydrate(...)` para retomar do estado atual.
   */
  get signedState(): SignedState | null { return this._signedState }

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
      const response = await this.connection.sendMessageAndWait(
        clientMessages.mount(`mount-${this.componentName}`, {
          component: this.componentName,
          props: toRecord(this.options.initialState),
          room: this.options.room,
          userId: this.options.userId,
        }),
      )

      if (!response.success) {
        throw new Error(response.error || 'Mount failed')
      }

      const result = readMountResult(response)
      if (!result) throw new Error('Mount failed: malformed server response')
      const componentId = result.componentId
      this._componentId = componentId
      this._mounted = true
      this._mounting = false

      // Merge initial state from server (as chaves são do estado do componente)
      if (result.initialState) this._state = { ...this._state, ...result.initialState } as TState
      if (result.signedState) this._signedState = result.signedState

      // Register for component messages (state updates, deltas, errors)
      this.unregisterComponent = this.connection.registerComponent(
        componentId,
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
      await this.connection.sendMessage(clientMessages.unmount(this._componentId))
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
  async call<R = unknown>(action: string, payload: unknown = {}): Promise<R> {
    if (!this._mounted || !this._componentId) {
      throw new Error(`Cannot call '${action}': component not mounted`)
    }

    this.log(`Calling action: ${action}`, payload)

    const response = await this.connection.sendMessageAndWait(
      clientMessages.callAction(this._componentId, action, payload),
    )

    if (!response.success) {
      const errorMsg = response.error || `Action '${action}' failed`
      this._error = errorMsg
      this.notifyError(errorMsg)
      throw new Error(errorMsg)
    }

    // O retorno da action é definido pelo componente do servidor; o chamador escolhe R.
    return response.result as R
  }

  /**
   * Fire an action without waiting for a response (fire-and-forget).
   * Useful for high-frequency operations like game input where the
   * server doesn't need to send back a result.
   */
  fire(action: string, payload: unknown = {}): void {
    if (!this._mounted || !this._componentId) return

    this.connection
      .sendMessage(clientMessages.callAction(this._componentId, action, payload, false))
      .catch(() => {})
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
  setBinaryDecoder(decoder: (buffer: Uint8Array) => Partial<TState>): () => void {
    if (!this._componentId) {
      throw new Error('Component must be mounted before setting binary decoder')
    }

    return this.connection.registerBinaryHandler(this._componentId, (payload: Uint8Array) => {
      try {
        const delta = decoder(payload)
        this._state = deepMerge(this._state, delta)
        this.notifyStateChange(this._state, delta)
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
        const update = readStateUpdate(msg)
        if (update) {
          this._state = deepMerge(this._state, update.state)
          if (update.signedState) this._signedState = update.signedState
          this.notifyStateChange(this._state, null)
        }
        break
      }

      case 'STATE_SIGNATURE': {
        const signed = readStateSignature(msg)
        if (signed) this._signedState = signed
        break
      }

      case 'STATE_DELTA': {
        const delta = readStateDelta(msg)
        if (delta) {
          this._state = deepMerge(this._state, delta)
          // Delta do servidor: chaves do estado deste componente.
          this.notifyStateChange(this._state, delta as Partial<TState>)
        }
        break
      }

      case 'ERROR': {
        const error = readErrorMessage(msg) || 'Unknown error'
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

  private log(message: string, data?: unknown): void {
    if (this.options.debug) {
      console.log(`[Live:${this.componentName}] ${message}`, data ?? '')
    }
  }
}
