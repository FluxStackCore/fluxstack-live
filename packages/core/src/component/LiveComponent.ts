// @fluxstack/live - LiveComponent Base Class
//
// Framework-agnostic base class for server-side Live Components.
// Uses getLiveComponentContext() for dependency injection instead of global singletons.
//
// Internally delegates to focused managers (composition pattern):
//   - ComponentStateManager: reactive state, proxy, binary delta
//   - ComponentMessaging: emit(), broadcast()
//   - ActionSecurityManager: action validation, rate limiting, Zod
//   - ComponentRoomProxy: $room, $rooms, room events

import { getLiveComponentContext, hasLiveComponentContext } from './context'
import { generateId as defaultGenerateId } from '../utils/generateId'
import type { GenericWebSocket } from '../transport/types'
import type { LiveAuthContext, LiveComponentAuth, LiveActionAuthMap } from '../auth/types'
import { ANONYMOUS_CONTEXT } from '../auth/LiveAuthContext'
import type { BroadcastMessage, ComponentState } from '../protocol/messages'

// Managers
import { ComponentStateManager } from './managers/ComponentStateManager'
import { ComponentMessaging, EMIT_OVERRIDE_KEY, STATE_DELTA_HOOK_KEY } from './managers/ComponentMessaging'
import { ActionSecurityManager, type ActionCaller, type ActionPayloadSchema } from './managers/ActionSecurityManager'
import { ComponentRoomProxy, type LiveComponentRoomAccessor } from './managers/ComponentRoomProxy'
import { errorMessage } from '../utils/errors'

// Re-export EMIT_OVERRIDE_KEY for external consumers
export { EMIT_OVERRIDE_KEY }
export type { LiveComponentRoomAccessor, TypedRoomHandle } from './managers/ComponentRoomProxy'

/**
 * Qualquer LiveComponent, com os genéricos apagados. Use em coleções
 * heterogêneas (registry, `ws.data.components`). `object` aceita tanto
 * interfaces quanto type aliases como TState/TPrivate.
 */
export type AnyLiveComponent = LiveComponent<object, object>

/** Estáticos que o framework lê de uma classe de componente. */
export interface LiveComponentStatics {
  componentName?: string
  defaultState?: object
  updatableFields?: readonly string[]
  publicActions?: readonly string[]
  auth?: LiveComponentAuth
  actionAuth?: LiveActionAuthMap
  actionSchemas?: Record<string, LiveActionSchema>
  actionRateLimit?: { maxCalls: number; windowMs: number; perAction?: boolean }
  persistent?: Record<string, unknown>
  singleton?: boolean
  logging?: boolean | readonly LiveComponentLogCategory[]
  $options?: ComponentOptions
}

/**
 * Construtor de um LiveComponent + seus estáticos. É o tipo aceito por
 * `LiveServer({ components })` e `ComponentRegistry.registerComponentClass`.
 */
export type LiveComponentClass<T extends AnyLiveComponent = AnyLiveComponent> = LiveComponentStatics & {
  readonly name: string
  new (initialState: Record<string, unknown>, ws: GenericWebSocket, options?: LiveComponentConstructorOptions): T
}

export interface ComponentOptions {
  /** Enable deep diff for plain objects in setState(). Default: true
   *  When enabled, nested plain objects are compared field-by-field and
   *  removed keys are emitted as `null` so clients can delete them via deepMerge.
   *  Set to false to opt into shallow (reference-equality) diffing. */
  deepDiff?: boolean
  /** Enable deep diff for room state updates. Default: true */
  roomDeepDiff?: boolean
  /** Max recursion depth for deep diff (component + room). Default: 3 */
  deepDiffDepth?: number
  /** When true, room state can only be set from server-side code. Client ROOM_STATE_SET is rejected. Default: false */
  serverOnlyRoomState?: boolean
  /** When true, the state proxy is RECURSIVE: a nested mutation like
   *  `this.state.nested.x = y` is detected and synced (default proxy is shallow,
   *  so nested mutations are silently dropped). Opt-in — costs extra proxies.
   *  Reference identity is preserved (`state.x === state.x`). Default: false. */
  recursiveProxy?: boolean
}

/** Opções do construtor de um LiveComponent (passadas pelo registry). */
export interface LiveComponentConstructorOptions {
  room?: string
  userId?: string
}

/** Categorias aceitas em `static logging`. */
export type LiveComponentLogCategory = 'lifecycle' | 'messages' | 'state' | 'performance' | 'rooms' | 'websocket'

/** Schema no formato Zod (só `safeParse` é usado). */
export type LiveActionSchema = ActionPayloadSchema

export abstract class LiveComponent<
  TState = ComponentState,
  TPrivate extends object = Record<string, unknown>
> {
  /** Component name for registry lookup - must be defined in subclasses */
  static componentName: string
  /** Default state - must be defined in subclasses */
  static defaultState: object

  /**
   * Campos que o cliente pode escrever via PROPERTY_UPDATE.
   * Quando ausente, vale a lista de chaves de `defaultState`.
   */
  static updatableFields?: readonly string[]

  /**
   * Per-component logging control. Silent by default.
   *
   * @example
   * static logging = true                           // all categories
   * static logging = ['lifecycle', 'messages']      // specific categories
   */
  static logging?: boolean | readonly LiveComponentLogCategory[]

  /**
   * Component-level auth configuration.
   */
  static auth?: LiveComponentAuth

  /**
   * Per-action auth configuration.
   */
  static actionAuth?: LiveActionAuthMap

  /**
   * Zod schemas for action payload validation.
   * When defined, payloads are validated before the action method is called.
   *
   * @example
   * static actionSchemas = {
   *   sendMessage: z.object({ text: z.string().max(500) }),
   *   updatePosition: z.object({ x: z.number(), y: z.number() }),
   * }
   */
  static actionSchemas?: Record<string, LiveActionSchema>

  /**
   * Rate limit for action execution.
   * Prevents clients from spamming expensive operations.
   *
   * @example
   * static actionRateLimit = { maxCalls: 10, windowMs: 1000, perAction: true }
   */
  static actionRateLimit?: {
    maxCalls: number
    windowMs: number
    perAction?: boolean
  }

  /**
   * Data that survives HMR reloads.
   */
  static persistent?: Record<string, unknown>

  /**
   * When true, only ONE server-side instance exists for this component.
   * All clients share the same state.
   */
  static singleton?: boolean

  /**
   * Component behavior options.
   *
   * @example
   * static $options = { deepDiff: true }
   */
  static $options?: ComponentOptions

  public readonly id: string
  public state: TState // Proxy wrapper (getter delegates to _stateManager)
  protected ws: GenericWebSocket
  public room?: string
  public userId?: string
  public broadcastToRoom: (message: BroadcastMessage) => void = () => {}

  // Server-only private state (NEVER sent to client)
  private _privateState: TPrivate = {} as TPrivate

  // Auth context (injected by registry during mount, immutable after first set)
  private _authContext: LiveAuthContext = ANONYMOUS_CONTEXT
  private _authContextSet = false

  // Room type for typed events (override in subclass)
  protected roomType: string = 'default'

  // Singleton emit override
  public [EMIT_OVERRIDE_KEY]: ((type: string, payload: unknown) => void) | null = null

  /** @internal Gancho pós-delta instalado pelo registry (renovação do signedState). */
  public [STATE_DELTA_HOOK_KEY]: (() => void) | null = null

  // ===== Internal Managers (composition) =====
  private _stateManager: ComponentStateManager<TState>
  private _messaging: ComponentMessaging
  private _actionSecurity: ActionSecurityManager
  private _roomProxyManager: ComponentRoomProxy

  static publicActions?: readonly string[]

  constructor(initialState: Partial<TState>, ws: GenericWebSocket, options?: LiveComponentConstructorOptions) {
    this.id = this.generateId()
    const ctor = this.constructor as typeof LiveComponent
    this.ws = ws
    this.room = options?.room
    this.userId = options?.userId

    // 1. Messaging (needed by state manager for emit)
    this._messaging = new ComponentMessaging({
      componentId: this.id,
      ws: this.ws,
      getUserId: () => this.userId,
      getRoom: () => this.room,
      getBroadcastToRoom: () => this.broadcastToRoom,
      getEmitOverride: () => this[EMIT_OVERRIDE_KEY],
    })

    // 2. State manager
    this._stateManager = new ComponentStateManager<TState>({
      componentId: this.id,
      initialState: { ...ctor.defaultState, ...initialState } as TState,
      ws: this.ws,
      emitFn: (type, payload) => this._messaging.emit(type, payload),
      onStateChangeFn: (changes) => this.onStateChange(changes),
      onDeltaFn: () => this[STATE_DELTA_HOOK_KEY]?.(),
      deepDiff: ctor.$options?.deepDiff ?? true,
      deepDiffDepth: ctor.$options?.deepDiffDepth,
      recursiveProxy: ctor.$options?.recursiveProxy ?? false,
    })

    // Expose proxy state as `this.state`
    this.state = this._stateManager.proxyState

    // 3. Action security
    this._actionSecurity = new ActionSecurityManager()

    // 4. Room proxy (context resolved lazily — only when room features are used)
    this._roomProxyManager = new ComponentRoomProxy({
      componentId: this.id,
      ws: this.ws,
      defaultRoom: this.room,
      getCtx: () => getLiveComponentContext(),
      setStateFn: (updates) => this.setState(updates as Partial<TState>),
      deepDiff: ctor.$options?.roomDeepDiff,
      deepDiffDepth: ctor.$options?.deepDiffDepth,
      serverOnlyState: ctor.$options?.serverOnlyRoomState,
    })

    // Create direct property accessors (this.count instead of this.state.count)
    this._stateManager.applyDirectAccessors(this, this.constructor)
  }

  // ========================================
  // $private - Server-Only State
  // ========================================

  public get $private(): TPrivate {
    return this._privateState
  }

  // ========================================
  // $room - Unified Room System
  // ========================================

  /**
   * Unified room accessor.
   *
   * Usage:
   * - `this.$room` — default room handle (legacy)
   * - `this.$room('roomId')` — untyped room handle (legacy)
   * - `this.$room(ChatRoom, 'lobby')` — typed handle with custom methods
   */
  public get $room(): LiveComponentRoomAccessor {
    return this._roomProxyManager.$room
  }

  /**
   * List of room IDs this component is participating in.
   * Cached — invalidated on join/leave.
   */
  public get $rooms(): string[] {
    return this._roomProxyManager.$rooms
  }

  // ========================================
  // $auth - Authentication Context
  // ========================================

  public get $auth(): LiveAuthContext {
    return this._authContext
  }

  /** @internal - Immutable after first set to prevent privilege escalation */
  public setAuthContext(context: LiveAuthContext): void {
    if (this._authContextSet) {
      throw new Error('Auth context is immutable after initial set')
    }
    this._authContext = context
    this._authContextSet = true
    if (context.authenticated && context.session?.id && !this.userId) {
      this.userId = context.session.id
    }
  }

  /** @internal - Reset auth context (for registry use in reconnection) */
  public _resetAuthContext(): void {
    this._authContextSet = false
    this._authContext = ANONYMOUS_CONTEXT
  }

  // ========================================
  // $persistent - HMR-Safe State
  // ========================================

  public get $persistent(): Record<string, unknown> {
    const ctor = this.constructor as typeof LiveComponent
    const name = ctor.componentName || ctor.name
    const key = `__fluxstack_persistent_${name}`
    // globalThis sobrevive ao HMR; guardamos os dados numa chave por componente.
    const store = globalThis as unknown as Record<string, Record<string, unknown> | undefined>

    if (!store[key]) {
      store[key] = { ...(ctor.persistent || {}) }
    }

    return store[key]!
  }

  // ========================================
  // Lifecycle Hooks
  // ========================================

  protected onConnect(): void {}
  protected onMount(): void | Promise<void> {}
  protected onDisconnect(): void {}
  protected onDestroy(): void {}
  protected onStateChange(changes: Partial<TState>): void {}
  protected onRoomJoin(roomId: string): void {}
  protected onRoomLeave(roomId: string): void {}
  protected onRehydrate(previousState: TState): void {}
  protected onAction(action: string, payload: unknown): void | false | Promise<void | false> {}
  protected onClientJoin(connectionId: string, connectionCount: number): void {}
  protected onClientLeave(connectionId: string, connectionCount: number): void {}

  // ========================================
  // State Management (delegates to _stateManager)
  // ========================================

  public setState(updates: Partial<TState> | ((prev: TState) => Partial<TState>)) {
    this._stateManager.setState(updates)
  }

  /**
   * Send a binary-encoded state delta directly over WebSocket.
   * Updates internal state (same as setState) then sends the encoder's output
   * as a binary frame: [0x01][idLen:u8][id_bytes:utf8][payload_bytes].
   * Bypasses the JSON batcher — ideal for high-frequency updates.
   */
  public sendBinaryDelta(
    delta: Partial<TState>,
    encoder: (delta: Partial<TState>) => Uint8Array
  ): void {
    this._stateManager.sendBinaryDelta(delta, encoder)
  }

  public setValue<K extends keyof TState>(payload: { key: K; value: TState[K] }): { success: true; key: K; value: TState[K] } {
    return this._stateManager.setValue(payload)
  }

  // ========================================
  // Action Execution (delegates to _actionSecurity)
  // ========================================

  public async executeAction(action: string, payload: unknown, caller?: ActionCaller): Promise<unknown> {
    return this._actionSecurity.validateAndExecute(action, payload, {
      component: this,
      componentClass: this.constructor as typeof LiveComponent,
      componentId: this.id,
      emitFn: (type, p) => this.emit(type, p),
      caller,
    })
  }

  // ========================================
  // Messaging (delegates to _messaging)
  // ========================================

  protected emit(type: string, payload: unknown) {
    this._messaging.emit(type, payload)
  }

  protected broadcast(type: string, payload: unknown, excludeCurrentUser = false) {
    this._messaging.broadcast(type, payload, excludeCurrentUser)
  }

  // ========================================
  // Room Events (delegates to _roomProxyManager)
  // ========================================

  protected emitRoomEvent(event: string, data: unknown, notifySelf = false): number {
    return this._roomProxyManager.emitRoomEvent(event, data, notifySelf)
  }

  protected onRoomEvent<T = unknown>(event: string, handler: (data: T) => void): void {
    this._roomProxyManager.onRoomEvent(event, handler)
  }

  protected emitRoomEventWithState(event: string, data: unknown, stateUpdates: Partial<TState>): number {
    return this._roomProxyManager.emitRoomEventWithState(event, data, stateUpdates)
  }

  protected subscribeToRoom(roomId: string) {
    this._roomProxyManager.subscribeToRoom(roomId)
    this.room = roomId
  }

  protected unsubscribeFromRoom() {
    this._roomProxyManager.unsubscribeFromRoom()
    this.room = undefined
  }

  // ========================================
  // Internal
  // ========================================

  private generateId(): string {
    if (hasLiveComponentContext()) {
      const ctx = getLiveComponentContext()
      if (ctx.generateId) return ctx.generateId()
    }
    return defaultGenerateId()
  }

  public destroy() {
    try {
      this.onDestroy()
    } catch (err) {
      console.error(`[${this.id}] onDestroy error:`, errorMessage(err))
    }

    // Cleanup room proxy (unsubscribers, leave rooms, clear handles)
    this._roomProxyManager.destroy()

    // Cleanup state manager (cached bytes)
    this._stateManager.cleanup()

    // Clear private state
    this._privateState = {} as TPrivate

    // Clear room on this instance
    this.room = undefined
  }

  public getSerializableState(): TState {
    return this._stateManager.getSerializableState()
  }
}
