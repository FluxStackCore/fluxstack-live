// @fluxstack/live - LiveComponent Base Class
//
// Framework-agnostic base class for server-side Live Components.
// Uses getLiveComponentContext() for dependency injection instead of global singletons.

import { getLiveComponentContext } from './context'
import type { LiveDebuggerInterface } from './context'
import type { GenericWebSocket } from '../transport/types'
import { queueWsMessage } from '../transport/WsSendBatcher'
import type { LiveAuthContext, LiveComponentAuth, LiveActionAuthMap } from '../auth/types'
import { ANONYMOUS_CONTEXT } from '../auth/LiveAuthContext'
import { liveLog, liveWarn } from '../debug/LiveLogger'
import type { LiveMessage, BroadcastMessage, ComponentState, ServerRoomHandle, ServerRoomProxy } from '../protocol/messages'

/** @internal Symbol key for singleton emit override */
export const EMIT_OVERRIDE_KEY = Symbol.for('fluxstack:emitOverride')

// ===== Debug Instrumentation (injectable to avoid client-side import) =====
let _liveDebugger: LiveDebuggerInterface | null = null

/** @internal Called by ComponentRegistry to inject the debugger instance */
export function _setLiveDebugger(dbg: LiveDebuggerInterface): void {
  _liveDebugger = dbg
}

export abstract class LiveComponent<TState = ComponentState, TPrivate extends Record<string, any> = Record<string, any>> {
  /** Component name for registry lookup - must be defined in subclasses */
  static componentName: string
  /** Default state - must be defined in subclasses */
  static defaultState: any

  /**
   * Per-component logging control. Silent by default.
   *
   * @example
   * static logging = true                           // all categories
   * static logging = ['lifecycle', 'messages']      // specific categories
   */
  static logging?: boolean | readonly ('lifecycle' | 'messages' | 'state' | 'performance' | 'rooms' | 'websocket')[]

  /**
   * Component-level auth configuration.
   */
  static auth?: LiveComponentAuth

  /**
   * Per-action auth configuration.
   */
  static actionAuth?: LiveActionAuthMap

  /**
   * Data that survives HMR reloads.
   */
  static persistent?: Record<string, any>

  /**
   * When true, only ONE server-side instance exists for this component.
   * All clients share the same state.
   */
  static singleton?: boolean

  public readonly id: string
  private _state: TState
  public state: TState // Proxy wrapper
  protected ws: GenericWebSocket
  public room?: string
  public userId?: string
  public broadcastToRoom: (message: BroadcastMessage) => void = () => {}

  // Server-only private state (NEVER sent to client)
  private _privateState: TPrivate = {} as TPrivate

  // Auth context (injected by registry during mount)
  private _authContext: LiveAuthContext = ANONYMOUS_CONTEXT

  // Room event subscriptions (cleaned up on destroy)
  private roomEventUnsubscribers: (() => void)[] = []
  private joinedRooms: Set<string> = new Set()

  // Room type for typed events (override in subclass)
  protected roomType: string = 'default'

  // Cached room handles
  private roomHandles: Map<string, ServerRoomHandle> = new Map()

  // Guard against infinite recursion in onStateChange
  private _inStateChange = false

  // Singleton emit override
  public [EMIT_OVERRIDE_KEY]: ((type: string, payload: any) => void) | null = null

  constructor(initialState: Partial<TState>, ws: GenericWebSocket, options?: { room?: string; userId?: string }) {
    this.id = this.generateId()
    const ctor = this.constructor as typeof LiveComponent
    this._state = { ...ctor.defaultState, ...initialState } as TState

    // Create reactive proxy that auto-syncs on mutation
    this.state = this.createStateProxy(this._state)

    this.ws = ws
    this.room = options?.room
    this.userId = options?.userId

    // Auto-join default room if specified
    if (this.room) {
      this.joinedRooms.add(this.room)
      const ctx = getLiveComponentContext()
      ctx.roomManager.joinRoom(this.id, this.room, this.ws)
    }

    // Create direct property accessors (this.count instead of this.state.count)
    this.createDirectStateAccessors()
  }

  // Create getters/setters for each state property directly on `this`
  private createDirectStateAccessors() {
    const forbidden = new Set([
      ...Object.keys(this),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(this)),
      'state', '_state', 'ws', 'id', 'room', 'userId', 'broadcastToRoom',
      '$private', '_privateState',
      '$room', '$rooms', 'roomType', 'roomHandles', 'joinedRooms', 'roomEventUnsubscribers'
    ])

    for (const key of Object.keys(this._state as object)) {
      if (!forbidden.has(key)) {
        Object.defineProperty(this, key, {
          get: () => (this._state as any)[key],
          set: (value) => { (this.state as any)[key] = value },
          enumerable: true,
          configurable: true
        })
      }
    }
  }

  // Create a Proxy that auto-emits STATE_DELTA on any mutation
  private createStateProxy(state: TState): TState {
    const self = this
    return new Proxy(state as object, {
      set(target, prop, value) {
        const oldValue = (target as any)[prop]
        if (oldValue !== value) {
          (target as any)[prop] = value
          const changes = { [prop]: value } as Partial<TState>
          self.emit('STATE_DELTA', { delta: changes })
          if (!self._inStateChange) {
            self._inStateChange = true
            try { self.onStateChange(changes) } catch (err: any) {
              console.error(`[${self.id}] onStateChange error:`, err?.message || err)
            } finally { self._inStateChange = false }
          }
          _liveDebugger?.trackStateChange(
            self.id,
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

  // ========================================
  // $private - Server-Only State
  // ========================================

  public get $private(): TPrivate {
    return this._privateState
  }

  // ========================================
  // $room - Unified Room System
  // ========================================

  public get $room(): ServerRoomProxy {
    const self = this
    const ctx = getLiveComponentContext()

    const createHandle = (roomId: string): ServerRoomHandle => {
      if (this.roomHandles.has(roomId)) {
        return this.roomHandles.get(roomId)!
      }

      const handle: ServerRoomHandle = {
        get id() { return roomId },
        get state() { return ctx.roomManager.getRoomState(roomId) },

        join: (initialState?: any) => {
          if (self.joinedRooms.has(roomId)) return
          self.joinedRooms.add(roomId)
          ctx.roomManager.joinRoom(self.id, roomId, self.ws, initialState)
          try { self.onRoomJoin(roomId) } catch (err: any) {
            console.error(`[${self.id}] onRoomJoin error:`, err?.message || err)
          }
        },

        leave: () => {
          if (!self.joinedRooms.has(roomId)) return
          self.joinedRooms.delete(roomId)
          ctx.roomManager.leaveRoom(self.id, roomId)
          try { self.onRoomLeave(roomId) } catch (err: any) {
            console.error(`[${self.id}] onRoomLeave error:`, err?.message || err)
          }
        },

        emit: (event: string, data: any): number => {
          return ctx.roomManager.emitToRoom(roomId, event, data, self.id)
        },

        on: (event: string, handler: (data: any) => void): (() => void) => {
          const unsubscribe = ctx.roomEvents.on(
            'room',
            roomId,
            event,
            self.id,
            handler
          )
          self.roomEventUnsubscribers.push(unsubscribe)
          return unsubscribe
        },

        setState: (updates: any) => {
          ctx.roomManager.setRoomState(roomId, updates, self.id)
        }
      }

      this.roomHandles.set(roomId, handle)
      return handle
    }

    const proxyFn = ((roomId: string) => createHandle(roomId)) as ServerRoomProxy

    const defaultHandle = this.room ? createHandle(this.room) : null

    Object.defineProperties(proxyFn, {
      id: { get: () => self.room },
      state: { get: () => defaultHandle?.state ?? {} },
      join: {
        value: (initialState?: any) => {
          if (!defaultHandle) throw new Error('No default room set')
          defaultHandle.join(initialState)
        }
      },
      leave: {
        value: () => {
          if (!defaultHandle) throw new Error('No default room set')
          defaultHandle.leave()
        }
      },
      emit: {
        value: (event: string, data: any) => {
          if (!defaultHandle) throw new Error('No default room set')
          return defaultHandle.emit(event, data)
        }
      },
      on: {
        value: (event: string, handler: (data: any) => void) => {
          if (!defaultHandle) throw new Error('No default room set')
          return defaultHandle.on(event, handler)
        }
      },
      setState: {
        value: (updates: any) => {
          if (!defaultHandle) throw new Error('No default room set')
          defaultHandle.setState(updates)
        }
      }
    })

    return proxyFn
  }

  /**
   * List of room IDs this component is participating in
   */
  public get $rooms(): string[] {
    return Array.from(this.joinedRooms)
  }

  // ========================================
  // $auth - Authentication Context
  // ========================================

  public get $auth(): LiveAuthContext {
    return this._authContext
  }

  /** @internal */
  public setAuthContext(context: LiveAuthContext): void {
    this._authContext = context
    if (context.authenticated && context.user?.id && !this.userId) {
      this.userId = context.user.id
    }
  }

  // ========================================
  // $persistent - HMR-Safe State
  // ========================================

  public get $persistent(): Record<string, any> {
    const ctor = this.constructor as typeof LiveComponent
    const name = ctor.componentName || ctor.name
    const key = `__fluxstack_persistent_${name}`

    if (!(globalThis as any)[key]) {
      (globalThis as any)[key] = { ...(ctor as any).persistent || {} }
    }

    return (globalThis as any)[key]
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
  protected onAction(action: string, payload: any): void | false | Promise<void | false> {}
  protected onClientJoin(connectionId: string, connectionCount: number): void {}
  protected onClientLeave(connectionId: string, connectionCount: number): void {}

  // ========================================
  // State Management
  // ========================================

  public setState(updates: Partial<TState> | ((prev: TState) => Partial<TState>)) {
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
    this.emit('STATE_DELTA', { delta: actualChanges })
    if (!this._inStateChange) {
      this._inStateChange = true
      try { this.onStateChange(actualChanges) } catch (err: any) {
        console.error(`[${this.id}] onStateChange error:`, err?.message || err)
      } finally { this._inStateChange = false }
    }
    _liveDebugger?.trackStateChange(
      this.id,
      actualChanges as Record<string, unknown>,
      this._state as Record<string, unknown>,
      'setState'
    )
  }

  public setValue<K extends keyof TState>(payload: { key: K; value: TState[K] }): { success: true; key: K; value: TState[K] } {
    const { key, value } = payload
    const update = { [key]: value } as unknown as Partial<TState>
    this.setState(update)
    return { success: true, key, value }
  }

  // ========================================
  // Action Security
  // ========================================

  static publicActions?: readonly string[]

  private static readonly BLOCKED_ACTIONS: ReadonlySet<string> = new Set([
    'constructor', 'destroy', 'executeAction', 'getSerializableState',
    'onMount', 'onDestroy', 'onConnect', 'onDisconnect',
    'onStateChange', 'onRoomJoin', 'onRoomLeave',
    'onRehydrate', 'onAction',
    'onClientJoin', 'onClientLeave',
    'setState', 'emit', 'broadcast', 'broadcastToRoom',
    'createStateProxy', 'createDirectStateAccessors', 'generateId',
    'setAuthContext', '$auth',
    '$private', '_privateState',
    '$persistent',
    '_inStateChange',
    '$room', '$rooms', 'subscribeToRoom', 'unsubscribeFromRoom',
    'emitRoomEvent', 'onRoomEvent', 'emitRoomEventWithState',
  ])

  public async executeAction(action: string, payload: any): Promise<any> {
    const actionStart = Date.now()
    try {
      if ((LiveComponent.BLOCKED_ACTIONS as Set<string>).has(action)) {
        throw new Error(`Action '${action}' is not callable`)
      }

      if (action.startsWith('_') || action.startsWith('#')) {
        throw new Error(`Action '${action}' is not callable`)
      }

      const componentClass = this.constructor as typeof LiveComponent
      const publicActions = componentClass.publicActions
      if (!publicActions) {
        console.warn(`[SECURITY] Component '${componentClass.componentName || componentClass.name}' has no publicActions defined. All remote actions are blocked.`)
        throw new Error(`Action '${action}' is not callable - component has no publicActions defined`)
      }
      if (!publicActions.includes(action)) {
        const methodExists = typeof (this as any)[action] === 'function'
        if (methodExists) {
          const name = componentClass.componentName || componentClass.name
          throw new Error(
            `Action '${action}' exists on '${name}' but is not listed in publicActions. ` +
            `Add it to: static publicActions = [..., '${action}']`
          )
        }
        throw new Error(`Action '${action}' is not callable`)
      }

      const method = (this as any)[action]
      if (typeof method !== 'function') {
        throw new Error(`Action '${action}' not found on component`)
      }

      if (Object.prototype.hasOwnProperty.call(Object.prototype, action)) {
        throw new Error(`Action '${action}' is not callable`)
      }

      _liveDebugger?.trackActionCall(this.id, action, payload)

      let hookResult: void | false | Promise<void | false>
      try {
        hookResult = await this.onAction(action, payload)
      } catch (hookError: any) {
        _liveDebugger?.trackActionError(this.id, action, hookError.message, Date.now() - actionStart)
        this.emit('ERROR', {
          action,
          error: `Action '${action}' failed pre-validation`
        })
        throw hookError
      }
      if (hookResult === false) {
        _liveDebugger?.trackActionError(this.id, action, 'Action cancelled', Date.now() - actionStart)
        throw new Error(`Action '${action}' was cancelled`)
      }

      const result = await method.call(this, payload)

      _liveDebugger?.trackActionResult(this.id, action, result, Date.now() - actionStart)

      return result
    } catch (error: any) {
      if (!error.message?.includes('was cancelled') && !error.message?.includes('pre-validation')) {
        _liveDebugger?.trackActionError(this.id, action, error.message, Date.now() - actionStart)

        this.emit('ERROR', {
          action,
          error: error.message
        })
      }
      throw error
    }
  }

  // ========================================
  // Messaging
  // ========================================

  protected emit(type: string, payload: any) {
    const override = this[EMIT_OVERRIDE_KEY]
    if (override) {
      override(type, payload)
      return
    }

    const message: LiveMessage = {
      type: type as any,
      componentId: this.id,
      payload,
      timestamp: Date.now(),
      userId: this.userId,
      room: this.room
    }

    if (this.ws) {
      // Queue to batcher — will be sent as part of a batched array on next microtask.
      // STATE_DELTA messages for the same componentId are deduplicated automatically.
      queueWsMessage(this.ws, message as any)
    }
  }

  protected broadcast(type: string, payload: any, excludeCurrentUser = false) {
    if (!this.room) {
      liveWarn('rooms', this.id, `[${this.id}] Cannot broadcast '${type}' - no room set`)
      return
    }

    const message: BroadcastMessage = {
      type,
      payload,
      room: this.room,
      excludeUser: excludeCurrentUser ? this.userId : undefined
    }

    liveLog('rooms', this.id, `[${this.id}] Broadcasting '${type}' to room '${this.room}'`)

    this.broadcastToRoom(message)
  }

  // ========================================
  // Room Events - Internal Server Events
  // ========================================

  protected emitRoomEvent(event: string, data: any, notifySelf = false): number {
    if (!this.room) {
      liveWarn('rooms', this.id, `[${this.id}] Cannot emit room event '${event}' - no room set`)
      return 0
    }

    const ctx = getLiveComponentContext()
    const excludeId = notifySelf ? undefined : this.id
    const notified = ctx.roomEvents.emit(this.roomType, this.room, event, data, excludeId)

    liveLog('rooms', this.id, `[${this.id}] Room event '${event}' -> ${notified} components`)

    _liveDebugger?.trackRoomEmit(this.id, this.room, event, data)

    return notified
  }

  protected onRoomEvent<T = any>(event: string, handler: (data: T) => void): void {
    if (!this.room) {
      liveWarn('rooms', this.id, `[${this.id}] Cannot subscribe to room event '${event}' - no room set`)
      return
    }

    const ctx = getLiveComponentContext()
    const unsubscribe = ctx.roomEvents.on(
      this.roomType,
      this.room,
      event,
      this.id,
      handler
    )

    this.roomEventUnsubscribers.push(unsubscribe)

    liveLog('rooms', this.id, `[${this.id}] Subscribed to room event '${event}'`)
  }

  protected emitRoomEventWithState(
    event: string,
    data: any,
    stateUpdates: Partial<TState>
  ): number {
    this.setState(stateUpdates)
    return this.emitRoomEvent(event, data, false)
  }

  protected subscribeToRoom(roomId: string) {
    this.room = roomId
  }

  protected unsubscribeFromRoom() {
    this.room = undefined
  }

  // ========================================
  // Internal
  // ========================================

  private generateId(): string {
    return `live-${crypto.randomUUID()}`
  }

  public destroy() {
    try {
      this.onDestroy()
    } catch (err: any) {
      console.error(`[${this.id}] onDestroy error:`, err?.message || err)
    }

    for (const unsubscribe of this.roomEventUnsubscribers) {
      unsubscribe()
    }
    this.roomEventUnsubscribers = []

    const ctx = getLiveComponentContext()
    for (const roomId of this.joinedRooms) {
      ctx.roomManager.leaveRoom(this.id, roomId)
    }
    this.joinedRooms.clear()
    this.roomHandles.clear()
    this._privateState = {} as TPrivate

    this.unsubscribeFromRoom()
  }

  public getSerializableState(): TState {
    return this.state
  }
}
