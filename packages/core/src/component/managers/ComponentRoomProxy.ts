// @fluxstack/live - Component Room Proxy Manager
//
// Handles $room proxy, $rooms, room event pub/sub, join/leave lifecycle.
// Extracted from LiveComponent for single-responsibility.
//
// The context getter is lazy — getLiveComponentContext() is only called when
// room features are actually used, not at construction time. This preserves
// backward compatibility with tests that construct LiveComponent without a
// running LiveServer.

import type { GenericWebSocket } from '../../transport/types'
import type { LiveComponentContext } from '../context'
import type { ServerRoomHandle, ServerRoomProxy } from '../../protocol/messages'
import type { LiveRoom, LiveRoomClass } from '../../rooms/LiveRoom'
import { liveLog, liveWarn } from '../../debug/LiveLogger'
import { sendImmediate } from '../../transport/WsSendBatcher'

export interface RoomProxyContext {
  componentId: string
  ws: GenericWebSocket
  defaultRoom?: string
  /** Lazy getter — only called when room features are used */
  getCtx: () => LiveComponentContext
  setStateFn: (updates: any) => void
  /** Deep diff setting for rooms (from component $options). Default: true */
  deepDiff?: boolean
  /** Max recursion depth for deep diff. Default: 3 */
  deepDiffDepth?: number
  /** When true, only server-side code can set room state. Default: false */
  serverOnlyState?: boolean
}

/** Keys that belong to the handle/proxy itself — never fall through to state */
const RESERVED_KEYS = new Set<string | symbol>([
  'id', 'state', 'join', 'leave', 'emit', 'on', 'setState',
  // Function internals (proxy wraps a function)
  'call', 'apply', 'bind', 'prototype', 'length', 'name', 'arguments', 'caller',
  // Symbol keys
  Symbol.toPrimitive, Symbol.toStringTag, Symbol.hasInstance,
])

/** Keys reserved on the typed LiveRoom handle — framework API keys */
const TYPED_RESERVED_KEYS = new Set<string | symbol>([
  'id', 'state', 'meta', 'join', 'leave', 'emit', 'on', 'setState', 'memberCount',
  // Proxy internals
  'then', 'toJSON', 'valueOf', 'toString',
  Symbol.toPrimitive, Symbol.toStringTag, Symbol.hasInstance,
])

/** Wrap a handle/proxy so unknown property access falls through to state */
function wrapWithStateProxy<T extends object>(
  target: T,
  getState: () => any,
  setState: (updates: any) => void,
): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      // Reserved keys → delegate to the original object
      if (RESERVED_KEYS.has(prop) || typeof prop === 'symbol') {
        return Reflect.get(obj, prop, receiver)
      }
      // Check if prop exists on the target itself first (defined properties)
      const desc = Object.getOwnPropertyDescriptor(obj, prop)
      if (desc) return Reflect.get(obj, prop, receiver)
      // Prototype methods (e.g. toString)
      if (prop in obj) return Reflect.get(obj, prop, receiver)
      // Fall through → read from room state
      const st = getState()
      return st?.[prop]
    },
    set(_obj, prop, value) {
      if (typeof prop === 'symbol') return false
      // Write to room state via setState
      setState({ [prop]: value })
      return true
    },
  })
}

export class ComponentRoomProxy {
  private roomEventUnsubscribers: (() => void)[] = []
  private joinedRooms: Set<string> = new Set()
  private roomHandles: Map<string, ServerRoomHandle> = new Map()
  private _roomProxy: ServerRoomProxy | null = null
  private _roomsCache: string[] | null = null
  private _cachedCtx: LiveComponentContext | null = null

  public roomType: string = 'default'
  public room?: string

  private componentId: string
  private ws: GenericWebSocket
  private getCtx: () => LiveComponentContext
  private setStateFn: (updates: any) => void
  private _deepDiff: boolean
  private _deepDiffDepth: number | undefined
  private _serverOnlyState: boolean

  constructor(rctx: RoomProxyContext) {
    this.componentId = rctx.componentId
    this.ws = rctx.ws
    this.room = rctx.defaultRoom
    this.getCtx = rctx.getCtx
    this.setStateFn = rctx.setStateFn
    this._deepDiff = rctx.deepDiff ?? true
    this._deepDiffDepth = rctx.deepDiffDepth
    this._serverOnlyState = rctx.serverOnlyState ?? false

    // Auto-join default room if specified
    if (this.room) {
      this.joinedRooms.add(this.room)
      this.ctx.roomManager.joinRoom(this.componentId, this.room, this.ws, undefined, { deepDiff: this._deepDiff, deepDiffDepth: this._deepDiffDepth, serverOnlyState: this._serverOnlyState })
    }
  }

  /** Lazy context resolution — cached after first access */
  private get ctx(): LiveComponentContext {
    if (!this._cachedCtx) {
      this._cachedCtx = this.getCtx()
    }
    return this._cachedCtx
  }

  get $room(): ServerRoomProxy {
    if (this._roomProxy) return this._roomProxy

    const self = this

    const createHandle = (roomId: string): ServerRoomHandle => {
      if (this.roomHandles.has(roomId)) {
        return this.roomHandles.get(roomId)!
      }

      const handle: ServerRoomHandle = {
        get id() { return roomId },
        get state() { return self.ctx.roomManager.getRoomState(roomId) },

        join: (initialState?: any) => {
          if (self.joinedRooms.has(roomId)) return
          self.joinedRooms.add(roomId)
          self._roomsCache = null
          self.ctx.roomManager.joinRoom(self.componentId, roomId, self.ws, initialState, { deepDiff: self._deepDiff, deepDiffDepth: self._deepDiffDepth, serverOnlyState: self._serverOnlyState })
          // onRoomJoin hook is called from LiveComponent
        },

        leave: () => {
          if (!self.joinedRooms.has(roomId)) return
          self.joinedRooms.delete(roomId)
          self._roomsCache = null
          self.ctx.roomManager.leaveRoom(self.componentId, roomId)
          // onRoomLeave hook is called from LiveComponent
        },

        emit: (event: string, data: any): number => {
          return self.ctx.roomManager.emitToRoom(roomId, event, data, self.componentId)
        },

        on: (event: string, handler: (data: any) => void): (() => void) => {
          const unsubscribe = self.ctx.roomEvents.on(
            'room',
            roomId,
            event,
            self.componentId,
            handler
          )
          self.roomEventUnsubscribers.push(unsubscribe)
          return unsubscribe
        },

        setState: (updates: any) => {
          self.ctx.roomManager.setRoomState(roomId, updates, self.componentId)
        }
      }

      const proxied = wrapWithStateProxy(
        handle,
        () => self.ctx.roomManager.getRoomState(roomId),
        (updates: any) => self.ctx.roomManager.setRoomState(roomId, updates, self.componentId),
      )
      this.roomHandles.set(roomId, proxied)
      return proxied
    }

    // Overloaded: $room('roomId') → untyped handle, $room(ChatRoom, 'lobby') → typed handle
    const proxyFn = ((roomIdOrClass: string | LiveRoomClass, instanceId?: string) => {
      if (typeof roomIdOrClass === 'function' && instanceId !== undefined) {
        return self.$typedRoom(roomIdOrClass as LiveRoomClass<any>, instanceId)
      }
      return createHandle(roomIdOrClass as string)
    }) as ServerRoomProxy

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

    // Wrap the top-level proxy so $room.players reads from default room state
    const defaultRoom = this.room
    const wrapped = defaultRoom
      ? wrapWithStateProxy(
          proxyFn,
          () => self.ctx.roomManager.getRoomState(defaultRoom),
          (updates: any) => self.ctx.roomManager.setRoomState(defaultRoom, updates, self.componentId),
        )
      : proxyFn

    this._roomProxy = wrapped as ServerRoomProxy
    return wrapped as ServerRoomProxy
  }

  /**
   * Get a typed room handle backed by a LiveRoom class.
   *
   * Usage: `this.$room(ChatRoom, 'lobby')` → typed handle with custom methods
   *
   * The returned handle exposes:
   * - `.id`, `.state`, `.meta`, `.memberCount` — framework properties
   * - `.join(payload?)`, `.leave()`, `.emit()`, `.on()`, `.setState()` — framework API
   * - Any custom method defined on the LiveRoom subclass (e.g. `.addMessage()`, `.ban()`)
   *
   * The compound room ID is `${roomClass.roomName}:${instanceId}`.
   */
  $typedRoom<R extends LiveRoom<any, any, any>>(
    roomClass: LiveRoomClass<R>,
    instanceId: string,
  ): R & {
    readonly id: string
    join: (payload?: any) => { rejected?: false } | { rejected: true; reason: string }
    leave: () => void
    emit: R['emit']
    on: <K extends string>(event: K, handler: (data: any) => void) => () => void
    setState: (updates: Partial<R['state']>) => void
    readonly memberCount: number
  } {
    const roomId = `${roomClass.roomName}:${instanceId}`
    const self = this

    // Return cached handle if it exists
    const cached = this.roomHandles.get(roomId)
    if (cached) return cached as any

    const handle = {
      get id() { return roomId },

      get state(): R['state'] {
        const instance = self.ctx.roomManager.getRoomInstance?.(roomId)
        return instance ? instance.state : self.ctx.roomManager.getRoomState(roomId)
      },

      get meta(): R['meta'] {
        const instance = self.ctx.roomManager.getRoomInstance?.(roomId)
        if (!instance) throw new Error(`Room '${roomId}' not found or not backed by a LiveRoom class`)
        return instance.meta
      },

      get memberCount(): number {
        return self.ctx.roomManager.getMemberCount?.(roomId) ?? 0
      },

      join: (payload?: any): { rejected?: false } | { rejected: true; reason: string } => {
        if (self.joinedRooms.has(roomId)) return {}
        const result = self.ctx.roomManager.joinRoom(
          self.componentId, roomId, self.ws, undefined, undefined,
          { userId: undefined, payload },
        )
        if ('rejected' in result && result.rejected) {
          return result
        }
        self.joinedRooms.add(roomId)
        self._roomsCache = null
        // Notify client about server-initiated join with initial state
        sendImmediate(self.ws, JSON.stringify({
          type: 'ROOM_JOINED',
          componentId: self.componentId,
          roomId: roomId,
          event: '$room:joined',
          data: { state: result.state },
          timestamp: Date.now(),
        }))
        return {}
      },

      leave: () => {
        if (!self.joinedRooms.has(roomId)) return
        self.joinedRooms.delete(roomId)
        self._roomsCache = null
        self.ctx.roomManager.leaveRoom(self.componentId, roomId, 'leave')
      },

      emit: ((event: string, data: any): number => {
        return self.ctx.roomManager.emitToRoom(roomId, event, data, self.componentId)
      }) as R['emit'],

      on: (event: string, handler: (data: any) => void): (() => void) => {
        const unsubscribe = self.ctx.roomEvents.on(
          'room', roomId, event, self.componentId, handler,
        )
        self.roomEventUnsubscribers.push(unsubscribe)
        return unsubscribe
      },

      setState: (updates: any) => {
        self.ctx.roomManager.setRoomState(roomId, updates, self.componentId)
      },
    }

    // Create a Proxy that falls through to the LiveRoom instance for custom methods
    const proxied = new Proxy(handle, {
      get(obj, prop, receiver) {
        // Reserved framework keys → handle
        if (TYPED_RESERVED_KEYS.has(prop) || typeof prop === 'symbol') {
          return Reflect.get(obj, prop, receiver)
        }
        // Check handle own properties first
        if (prop in obj) return Reflect.get(obj, prop, receiver)
        // Fall through to LiveRoom instance (custom methods like addMessage, ban, etc.)
        const instance = self.ctx.roomManager.getRoomInstance?.(roomId)
        if (instance && prop in instance) {
          const val = (instance as any)[prop]
          // Bind methods to the instance
          return typeof val === 'function' ? val.bind(instance) : val
        }
        return undefined
      },
    })

    this.roomHandles.set(roomId, proxied as any)
    return proxied as any
  }

  get $rooms(): string[] {
    if (this._roomsCache) return this._roomsCache
    this._roomsCache = Array.from(this.joinedRooms)
    return this._roomsCache
  }

  getJoinedRooms(): Set<string> {
    return this.joinedRooms
  }

  emitRoomEvent(event: string, data: any, notifySelf = false): number {
    if (!this.room) {
      liveWarn('rooms', this.componentId, `[${this.componentId}] Cannot emit room event '${event}' - no room set`)
      return 0
    }

    const excludeId = notifySelf ? undefined : this.componentId
    const notified = this.ctx.roomEvents.emit(this.roomType, this.room, event, data, excludeId)

    liveLog('rooms', this.componentId, `[${this.componentId}] Room event '${event}' -> ${notified} components`)

    return notified
  }

  onRoomEvent<T = any>(event: string, handler: (data: T) => void): void {
    if (!this.room) {
      liveWarn('rooms', this.componentId, `[${this.componentId}] Cannot subscribe to room event '${event}' - no room set`)
      return
    }

    const unsubscribe = this.ctx.roomEvents.on(
      this.roomType,
      this.room,
      event,
      this.componentId,
      handler
    )

    this.roomEventUnsubscribers.push(unsubscribe)

    liveLog('rooms', this.componentId, `[${this.componentId}] Subscribed to room event '${event}'`)
  }

  emitRoomEventWithState(event: string, data: any, stateUpdates: any): number {
    this.setStateFn(stateUpdates)
    return this.emitRoomEvent(event, data, false)
  }

  subscribeToRoom(roomId: string): void {
    this.room = roomId
  }

  unsubscribeFromRoom(): void {
    this.room = undefined
  }

  destroy(): void {
    for (const unsubscribe of this.roomEventUnsubscribers) {
      unsubscribe()
    }
    this.roomEventUnsubscribers = []

    // Only access ctx if we have joined rooms (avoids throwing when no context exists)
    if (this.joinedRooms.size > 0 && this._cachedCtx) {
      for (const roomId of this.joinedRooms) {
        this._cachedCtx.roomManager.leaveRoom(this.componentId, roomId)
      }
    }
    this.joinedRooms.clear()
    this.roomHandles.clear()
    this._roomProxy = null
    this._roomsCache = null
  }
}
