// @fluxstack/live - Component State Manager
//
// Handles reactive state proxy, setState, sendBinaryDelta, direct accessors.
// Extracted from LiveComponent for single-responsibility.

import type { GenericWebSocket } from '../../transport/types'
import type { ComponentState } from '../../protocol/messages'
import { computeDeepDiff, deepAssign } from '../../utils/deepDiff'
import { liveWarn } from '../../debug/LiveLogger'

/** Per-class cache for forbidden property names in createDirectStateAccessors */
const _forbiddenSetCache = new WeakMap<Function, Set<string>>()

/** True for plain objects and arrays (the structures we recursively proxy). */
function isPlainObjectOrArray(v: unknown): v is object {
  if (v === null || typeof v !== 'object') return false
  if (Array.isArray(v)) return true
  return Object.getPrototypeOf(v) === Object.prototype
}

export interface StateManagerOptions<TState> {
  componentId: string
  initialState: TState
  ws: GenericWebSocket
  emitFn: (type: string, payload: any) => void
  onStateChangeFn: (changes: Partial<TState>) => void
  deepDiff?: boolean
  deepDiffDepth?: number
  recursiveProxy?: boolean
}

export class ComponentStateManager<TState = ComponentState> {
  private _state: TState
  private _proxyState: TState
  private _inStateChange = false
  private _idBytes: Uint8Array | null = null
  private _deepDiff: boolean
  private _deepDiffDepth: number
  private _recursiveProxy: boolean
  /** Caches child proxies per nested object so identity is preserved. */
  private _childProxies = new WeakMap<object, object>()

  private componentId: string
  private ws: GenericWebSocket
  private emitFn: (type: string, payload: any) => void
  private onStateChangeFn: (changes: Partial<TState>) => void

  constructor(opts: StateManagerOptions<TState>) {
    this.componentId = opts.componentId
    this.ws = opts.ws
    this.emitFn = opts.emitFn
    this.onStateChangeFn = opts.onStateChangeFn
    this._deepDiff = opts.deepDiff ?? true
    this._deepDiffDepth = opts.deepDiffDepth ?? 3
    this._recursiveProxy = opts.recursiveProxy ?? false
    // When deepDiff is enabled, deep-clone initialState so deepAssign
    // doesn't mutate shared references (e.g. static defaultState).
    this._state = this._deepDiff
      ? structuredClone(opts.initialState)
      : opts.initialState
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
        }
        return true
      },
      get(target, prop) {
        const value = (target as any)[prop]
        // Recursive proxy (opt-in): wrap nested plain objects so a mutation like
        // `state.nested.x = y` is detected and synced. Shallow proxy (default)
        // would drop it silently. Identity is preserved via the child cache.
        if (self._recursiveProxy && isPlainObjectOrArray(value)) {
          return self.wrapChild(value, prop as string)
        }
        return value
      }
    }) as TState
  }

  /**
   * Wrap a nested object/array so writes re-emit through setState under the
   * top-level `rootKey`, reusing the deep-diff pipeline. Cached per target to
   * keep reference identity (`state.x === state.x`).
   *
   * Writes do NOT mutate the live object directly — they build a clone of the
   * root value with the change applied and hand it to setState. That way the
   * deep diff compares the clone against the still-old internal state and emits
   * the minimal delta (mutating in place would make both sides equal → no delta).
   */
  private wrapChild(obj: object, rootKey: string): object {
    const cached = this._childProxies.get(obj)
    if (cached) return cached
    const self = this
    /** Emit a delta for the nested mutation: snapshot the root, run the mutation,
     *  diff before/after, and emit only the changed sub-tree under rootKey. */
    const withDelta = (mutate: () => void) => {
      const before = structuredClone((self._state as any)[rootKey])
      mutate()
      const after = (self._state as any)[rootKey]
      const subDiff = self._deepDiff
        ? computeDeepDiff({ [rootKey]: before } as any, { [rootKey]: after } as any, 0, self._deepDiffDepth)
        : { [rootKey]: after }
      if (subDiff === null) return
      self.emitFn('STATE_DELTA', { delta: subDiff })
      if (!self._inStateChange) {
        self._inStateChange = true
        try { self.onStateChangeFn(subDiff as Partial<TState>) } catch (err: any) {
          console.error(`[${self.componentId}] onStateChange error:`, err?.message || err)
        } finally { self._inStateChange = false }
      }
    }
    const proxy = new Proxy(obj, {
      get(target, prop) {
        const value = (target as any)[prop]
        if (isPlainObjectOrArray(value)) return self.wrapChild(value, rootKey)
        return value
      },
      set(target, prop, value) {
        if ((target as any)[prop] === value) return true
        withDelta(() => { (target as any)[prop] = value })
        return true
      },
      deleteProperty(target, prop) {
        if (!(prop in target)) return true
        withDelta(() => { delete (target as any)[prop] })
        return true
      },
    })
    this._childProxies.set(obj, proxy)
    return proxy
  }

  setState(updates: Partial<TState> | ((prev: TState) => Partial<TState>)): void {
    const newUpdates = typeof updates === 'function' ? updates(this._state) : updates

    let actualChanges: Partial<TState>
    let hasChanges: boolean

    if (this._deepDiff) {
      // Dev warning: detect shared references between patch and current state.
      // A plain object in the patch that is === to the current state value will
      // cause deepDiff to short-circuit and silently drop the update — a common
      // footgun when doing shallow clones of room state (issue #19).
      if (process.env.NODE_ENV !== 'production') {
        for (const key of Object.keys(newUpdates as object)) {
          const patchVal = (newUpdates as any)[key]
          const stateVal = (this._state as any)[key]
          if (
            patchVal !== null &&
            typeof patchVal === 'object' &&
            !Array.isArray(patchVal) &&
            Object.getPrototypeOf(patchVal) === Object.prototype &&
            patchVal === stateVal
          ) {
            liveWarn('state', this.componentId,
              `[${this.componentId}] setState: patch key "${key}" is the same reference as current state. ` +
              `Nested updates will be silently dropped by deepDiff. ` +
              `Use a shallow clone ({ ...this.state.${key}, ... }) or deep clone to avoid this. (issue #19)`)
          }
        }
      }

      // Deep diff: recursively compare plain objects, reference-compare everything else
      const diff = computeDeepDiff(
        this._state as Record<string, unknown>,
        newUpdates as Record<string, unknown>,
        0,
        this._deepDiffDepth,
      )
      if (diff === null) return
      actualChanges = diff as Partial<TState>
      hasChanges = true
    } else {
      // Shallow diff: reference equality (original behavior)
      actualChanges = {} as Partial<TState>
      hasChanges = false
      for (const key of Object.keys(newUpdates as object) as Array<keyof TState>) {
        if ((this._state as any)[key] !== (newUpdates as any)[key]) {
          (actualChanges as any)[key] = (newUpdates as any)[key]
          hasChanges = true
        }
      }
    }

    if (!hasChanges) return

    // Apply changes to internal state
    if (this._deepDiff) {
      deepAssign(this._state, actualChanges)
    } else {
      Object.assign(this._state as object, actualChanges)
    }

    this.emitFn('STATE_DELTA', { delta: actualChanges })
    if (!this._inStateChange) {
      this._inStateChange = true
      try { this.onStateChangeFn(actualChanges) } catch (err: any) {
        console.error(`[${this.componentId}] onStateChange error:`, err?.message || err)
      } finally { this._inStateChange = false }
    }
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
      // Fixes #7 H1: the binary frame length prefix is a u8, so any id
      // longer than 255 bytes would silently wrap and corrupt the wire
      // (the client would read `idBytes.length & 0xff` bytes of id and
      // treat the rest as payload). Framework-generated ids are ~41 bytes,
      // so this is only reachable via custom ids — we fail loud instead.
      if (this._idBytes.length > 255) {
        this._idBytes = null
        throw new Error(
          `[ComponentStateManager] componentId is ${new TextEncoder().encode(this.componentId).length} bytes after UTF-8 encoding, ` +
          `which exceeds the 255-byte limit of the binary frame length prefix. ` +
          `Use a shorter id (framework-generated ids are ~41 bytes).`
        )
      }
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
