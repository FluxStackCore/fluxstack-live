// @fluxstack/live - Component State Manager
//
// Handles reactive state proxy, setState, sendBinaryDelta, direct accessors.
// Extracted from LiveComponent for single-responsibility.

import type { GenericWebSocket } from '../../transport/types'
import type { LiveDebuggerInterface } from '../context'
import type { ComponentState } from '../../protocol/messages'

/** Per-class cache for forbidden property names in createDirectStateAccessors */
const _forbiddenSetCache = new WeakMap<Function, Set<string>>()

export interface StateManagerOptions<TState> {
  componentId: string
  initialState: TState
  ws: GenericWebSocket
  emitFn: (type: string, payload: any) => void
  onStateChangeFn: (changes: Partial<TState>) => void
  debugger?: LiveDebuggerInterface | null
}

export class ComponentStateManager<TState = ComponentState> {
  private _state: TState
  private _proxyState: TState
  private _inStateChange = false
  private _idBytes: Uint8Array | null = null

  private componentId: string
  private ws: GenericWebSocket
  private emitFn: (type: string, payload: any) => void
  private onStateChangeFn: (changes: Partial<TState>) => void
  private _debugger: LiveDebuggerInterface | null

  constructor(opts: StateManagerOptions<TState>) {
    this.componentId = opts.componentId
    this.ws = opts.ws
    this.emitFn = opts.emitFn
    this.onStateChangeFn = opts.onStateChangeFn
    this._debugger = opts.debugger ?? null
    this._state = opts.initialState
    this._proxyState = this.createStateProxy(this._state)
  }

  get rawState(): TState { return this._state }
  get proxyState(): TState { return this._proxyState }

  /** Guard flag — prevents infinite recursion in onStateChange */
  get inStateChange(): boolean { return this._inStateChange }

  private createStateProxy(state: TState): TState {
    const self = this
    return new Proxy(state as object, {
      set(target, prop, value) {
        const oldValue = (target as any)[prop]
        if (oldValue !== value) {
          (target as any)[prop] = value
          const changes = { [prop]: value } as Partial<TState>
          self.emitFn('STATE_DELTA', { delta: changes })
          if (!self._inStateChange) {
            self._inStateChange = true
            try { self.onStateChangeFn(changes) } catch (err: any) {
              console.error(`[${self.componentId}] onStateChange error:`, err?.message || err)
            } finally { self._inStateChange = false }
          }
          self._debugger?.trackStateChange(
            self.componentId,
            changes as Record<string, unknown>,
            target as Record<string, unknown>,
            'proxy'
          )
        }
        return true
      },
      get(target, prop) {
        return (target as any)[prop]
      }
    }) as TState
  }

  setState(updates: Partial<TState> | ((prev: TState) => Partial<TState>)): void {
    const newUpdates = typeof updates === 'function' ? updates(this._state) : updates

    const actualChanges: Partial<TState> = {} as Partial<TState>
    let hasChanges = false
    for (const key of Object.keys(newUpdates as object) as Array<keyof TState>) {
      if ((this._state as any)[key] !== (newUpdates as any)[key]) {
        (actualChanges as any)[key] = (newUpdates as any)[key]
        hasChanges = true
      }
    }

    if (!hasChanges) return

    Object.assign(this._state as object, actualChanges)
    this.emitFn('STATE_DELTA', { delta: actualChanges })
    if (!this._inStateChange) {
      this._inStateChange = true
      try { this.onStateChangeFn(actualChanges) } catch (err: any) {
        console.error(`[${this.componentId}] onStateChange error:`, err?.message || err)
      } finally { this._inStateChange = false }
    }
    this._debugger?.trackStateChange(
      this.componentId,
      actualChanges as Record<string, unknown>,
      this._state as Record<string, unknown>,
      'setState'
    )
  }

  sendBinaryDelta(
    delta: Partial<TState>,
    encoder: (delta: Partial<TState>) => Uint8Array
  ): void {
    const actualChanges: Partial<TState> = {} as Partial<TState>
    let hasChanges = false
    for (const key of Object.keys(delta as object) as Array<keyof TState>) {
      if ((this._state as any)[key] !== (delta as any)[key]) {
        (actualChanges as any)[key] = (delta as any)[key]
        hasChanges = true
      }
    }

    if (!hasChanges) return

    Object.assign(this._state as object, actualChanges)

    const payload = encoder(actualChanges)

    if (!this._idBytes) {
      this._idBytes = new TextEncoder().encode(this.componentId)
    }
    const idBytes = this._idBytes
    const frame = new Uint8Array(1 + 1 + idBytes.length + payload.length)
    frame[0] = 0x01  // BINARY_STATE_DELTA
    frame[1] = idBytes.length
    frame.set(idBytes, 2)
    frame.set(payload, 2 + idBytes.length)

    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(frame)
    }
  }

  setValue<K extends keyof TState>(payload: { key: K; value: TState[K] }): { success: true; key: K; value: TState[K] } {
    const { key, value } = payload
    const update = { [key]: value } as unknown as Partial<TState>
    this.setState(update)
    return { success: true, key, value }
  }

  getSerializableState(): TState {
    return this._proxyState
  }

  /**
   * Create getters/setters for each state property directly on `target`.
   * This allows `this.count` instead of `this.state.count` in subclasses.
   */
  applyDirectAccessors(target: any, constructorFn: Function): void {
    let forbidden = _forbiddenSetCache.get(constructorFn)
    if (!forbidden) {
      forbidden = new Set([
        ...Object.keys(target),
        ...Object.getOwnPropertyNames(Object.getPrototypeOf(target)),
        'state', '_state', 'ws', 'id', 'room', 'userId', 'broadcastToRoom',
        '$private', '_privateState',
        '$room', '$rooms', 'roomType', 'roomHandles', 'joinedRooms', 'roomEventUnsubscribers',
        // Internal manager fields
        '_stateManager', '_roomProxyManager', '_actionSecurity', '_messaging',
      ])
      _forbiddenSetCache.set(constructorFn, forbidden)
    }

    for (const key of Object.keys(this._state as object)) {
      if (!forbidden.has(key)) {
        Object.defineProperty(target, key, {
          get: () => (this._state as any)[key],
          set: (value) => { (this._proxyState as any)[key] = value },
          enumerable: true,
          configurable: true
        })
      }
    }
  }

  /** Release cached resources */
  cleanup(): void {
    this._idBytes = null
  }
}
