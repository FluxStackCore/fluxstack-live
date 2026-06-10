// @fluxstack/live-client - Room Manager (Client-side)
//
// Framework-agnostic room system for managing multi-room WebSocket communication.
// Used by framework-specific adapters (React, Vue, etc.).

// ===== Deep Merge (always-on, retrocompatible) =====

function isPlainObject(v: unknown): v is Record<string, any> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    && Object.getPrototypeOf(v) === Object.prototype
}

/**
 * Apply a room STATE_DELTA coming from the server.
 *
 * Semantics (matches core's `deepAssign`, fixes #6):
 * - Top-level `null` is a real value (set to null).
 * - Nested `null` is the deletion sentinel from `computeDeepDiff`.
 * - `undefined` is skipped — it never crosses the wire.
 */
function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>, seen?: Set<object>): T {
  return deepMergeImpl(target, source, 0, seen)
}

function deepMergeImpl<T extends Record<string, any>>(target: T, source: Partial<T>, depth: number, seen?: Set<object>): T {
  if (!seen) seen = new Set()
  if (seen.has(source as object)) return target
  seen.add(source as object)

  const result = { ...target }
  for (const key of Object.keys(source) as Array<keyof T>) {
    const newVal = source[key]
    if (newVal === undefined) continue
    if (newVal === null) {
      if (depth === 0) {
        result[key] = null as T[keyof T]
      } else {
        delete result[key]
      }
      continue
    }
    const oldVal = result[key]
    if (isPlainObject(oldVal) && isPlainObject(newVal)) {
      result[key] = deepMergeImpl(oldVal as any, newVal as any, depth + 1, seen) as T[keyof T]
    } else {
      result[key] = newVal as T[keyof T]
    }
  }
  return result
}

type EventHandler<T = any> = (data: T) => void
type Unsubscribe = () => void

// ===== Binary Room Frame Constants =====

const BINARY_ROOM_EVENT = 0x02
const BINARY_ROOM_STATE = 0x03

// ===== Lightweight msgpack decoder (client-side, decode-only) =====

const _decoder = new TextDecoder()
/** Max nesting depth — guards against stack overflow on malicious/corrupt frames. */
const _MSGPACK_MAX_DEPTH = 100

function msgpackDecode(buf: Uint8Array): unknown {
  return _decodeAt(buf, 0, 0).value
}

function _decodeAt(buf: Uint8Array, offset: number, depth: number): { value: unknown; offset: number } {
  if (depth > _MSGPACK_MAX_DEPTH) {
    throw new RangeError(`msgpack: max nesting depth ${_MSGPACK_MAX_DEPTH} exceeded (corrupt frame)`)
  }
  if (offset >= buf.length) return { value: null, offset }
  const byte = buf[offset]
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)

  if (byte < 0x80) return { value: byte, offset: offset + 1 }
  if (byte >= 0x80 && byte <= 0x8f) return _decodeMap(buf, offset + 1, byte & 0x0f, depth)
  if (byte >= 0x90 && byte <= 0x9f) return _decodeArr(buf, offset + 1, byte & 0x0f, depth)
  if (byte >= 0xa0 && byte <= 0xbf) {
    const len = byte & 0x1f
    return { value: _decoder.decode(buf.subarray(offset + 1, offset + 1 + len)), offset: offset + 1 + len }
  }
  if (byte >= 0xe0) return { value: byte - 256, offset: offset + 1 }

  switch (byte) {
    case 0xc0: return { value: null, offset: offset + 1 }
    case 0xc2: return { value: false, offset: offset + 1 }
    case 0xc3: return { value: true, offset: offset + 1 }
    case 0xc4: { const l = buf[offset + 1]; return { value: buf.slice(offset + 2, offset + 2 + l), offset: offset + 2 + l } }
    case 0xc5: { const l = view.getUint16(offset + 1, false); return { value: buf.slice(offset + 3, offset + 3 + l), offset: offset + 3 + l } }
    case 0xc6: { const l = view.getUint32(offset + 1, false); return { value: buf.slice(offset + 5, offset + 5 + l), offset: offset + 5 + l } }
    case 0xcb: return { value: view.getFloat64(offset + 1, false), offset: offset + 9 }
    case 0xcc: return { value: buf[offset + 1], offset: offset + 2 }
    case 0xcd: return { value: view.getUint16(offset + 1, false), offset: offset + 3 }
    case 0xce: return { value: view.getUint32(offset + 1, false), offset: offset + 5 }
    case 0xd0: return { value: view.getInt8(offset + 1), offset: offset + 2 }
    case 0xd1: return { value: view.getInt16(offset + 1, false), offset: offset + 3 }
    case 0xd2: return { value: view.getInt32(offset + 1, false), offset: offset + 5 }
    case 0xd9: { const l = buf[offset + 1]; return { value: _decoder.decode(buf.subarray(offset + 2, offset + 2 + l)), offset: offset + 2 + l } }
    case 0xda: { const l = view.getUint16(offset + 1, false); return { value: _decoder.decode(buf.subarray(offset + 3, offset + 3 + l)), offset: offset + 3 + l } }
    case 0xdb: { const l = view.getUint32(offset + 1, false); return { value: _decoder.decode(buf.subarray(offset + 5, offset + 5 + l)), offset: offset + 5 + l } }
    case 0xdc: return _decodeArr(buf, offset + 3, view.getUint16(offset + 1, false), depth)
    case 0xdd: return _decodeArr(buf, offset + 5, view.getUint32(offset + 1, false), depth)
    case 0xde: return _decodeMap(buf, offset + 3, view.getUint16(offset + 1, false), depth)
    case 0xdf: return _decodeMap(buf, offset + 5, view.getUint32(offset + 1, false), depth)
  }
  return { value: null, offset: offset + 1 }
}

function _decodeArr(buf: Uint8Array, offset: number, count: number, depth: number): { value: unknown[]; offset: number } {
  const arr: unknown[] = new Array(count)
  for (let i = 0; i < count; i++) { const r = _decodeAt(buf, offset, depth + 1); arr[i] = r.value; offset = r.offset }
  return { value: arr, offset }
}

function _decodeMap(buf: Uint8Array, offset: number, count: number, depth: number): { value: Record<string, unknown>; offset: number } {
  const obj: Record<string, unknown> = {}
  for (let i = 0; i < count; i++) {
    const k = _decodeAt(buf, offset, depth + 1); offset = k.offset
    const v = _decodeAt(buf, offset, depth + 1); offset = v.offset
    obj[String(k.value)] = v.value
  }
  return { value: obj, offset }
}

/** Parse a binary room frame: [frameType][compIdLen][compId][roomIdLen][roomId][eventLen:u16][event][payload] */
function parseRoomFrame(buf: Uint8Array): {
  frameType: number; componentId: string; roomId: string; event: string; payload: Uint8Array
} | null {
  if (buf.length < 6) return null
  let offset = 0
  const frameType = buf[offset++]
  const compIdLen = buf[offset++]
  if (offset + compIdLen > buf.length) return null
  const componentId = _decoder.decode(buf.subarray(offset, offset + compIdLen)); offset += compIdLen
  const roomIdLen = buf[offset++]
  if (offset + roomIdLen > buf.length) return null
  const roomId = _decoder.decode(buf.subarray(offset, offset + roomIdLen)); offset += roomIdLen
  if (offset + 2 > buf.length) return null
  const eventLen = (buf[offset] << 8) | buf[offset + 1]; offset += 2
  if (offset + eventLen > buf.length) return null
  const event = _decoder.decode(buf.subarray(offset, offset + eventLen)); offset += eventLen
  return { frameType, componentId, roomId, event, payload: buf.subarray(offset) }
}

/** Reserved property names on RoomHandle/RoomProxy (never fall through to state) */
const ROOM_RESERVED_KEYS = new Set<string | symbol>([
  'id', 'joined', 'state', 'join', 'leave', 'emit', 'on', 'onSystem', 'setState', 'removeAllListeners',
  'call', 'apply', 'bind', 'prototype', 'length', 'name', 'arguments', 'caller',
  Symbol.toPrimitive, Symbol.toStringTag, Symbol.hasInstance,
])

/** Wrap a handle/proxy so unknown property access falls through to state */
function wrapWithStateProxy<T extends object>(
  target: T,
  getState: () => any,
  setStateFn: (updates: any) => void,
): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (ROOM_RESERVED_KEYS.has(prop) || typeof prop === 'symbol') {
        return Reflect.get(obj, prop, receiver)
      }
      const desc = Object.getOwnPropertyDescriptor(obj, prop)
      if (desc) return Reflect.get(obj, prop, receiver)
      if (prop in obj) return Reflect.get(obj, prop, receiver)
      const st = getState()
      return st?.[prop]
    },
    set(_obj, prop, value) {
      if (typeof prop === 'symbol') return false
      setStateFn({ [prop]: value })
      return true
    },
  })
}

/** Reserved keys on RoomHandle/RoomProxy — cannot be state fields */
type RoomReservedKeys = 'id' | 'joined' | 'state' | 'join' | 'leave' | 'emit' | 'on' | 'onSystem' | 'setState' | 'removeAllListeners'

/** State fields accessible directly on handle/proxy (excludes reserved method names) */
type RoomStateFields<TState> = TState extends Record<string, any>
  ? { readonly [K in Exclude<keyof TState, RoomReservedKeys>]: TState[K] }
  : unknown

/** Message from client to server */
export interface RoomClientMessage {
  type: 'ROOM_JOIN' | 'ROOM_LEAVE' | 'ROOM_EMIT' | 'ROOM_STATE_GET' | 'ROOM_STATE_SET'
  componentId: string
  roomId: string
  event?: string
  data?: any
  timestamp: number
}

/** Message from server to client */
export interface RoomServerMessage {
  type: 'ROOM_EVENT' | 'ROOM_STATE' | 'ROOM_SYSTEM' | 'ROOM_JOINED' | 'ROOM_LEFT'
  componentId: string
  roomId: string
  event: string
  data: any
  timestamp: number
}

/** Interface of an individual room handle */
export type RoomHandle<TState = any, TEvents extends Record<string, any> = Record<string, any>> = {
  readonly id: string
  readonly joined: boolean
  readonly state: TState
  join: (initialState?: TState) => Promise<void>
  leave: () => Promise<void>
  emit: <K extends keyof TEvents>(event: K, data: TEvents[K]) => void
  on: <K extends keyof TEvents>(event: K, handler: EventHandler<TEvents[K]>) => Unsubscribe
  onSystem: (event: string, handler: EventHandler) => Unsubscribe
  setState: (updates: Partial<TState>) => void
  /** Remove all handlers for an event, or all handlers across all events if no event is given. */
  removeAllListeners: (event?: keyof TEvents | string) => void
} & RoomStateFields<TState>

/** Infer TEvents from a LiveRoom class (via $events brand) or use T directly as events map */
export type InferRoomEvents<T> =
  T extends { $events: infer E extends Record<string, any> } ? E :
  T extends Record<string, any> ? T :
  Record<string, any>

/** Proxy interface for $room - callable as function or object */
export type RoomProxy<TState = any, TEvents extends Record<string, any> = Record<string, any>> = {
  /** Get a typed room handle. Pass the Room class or events interface as generic:
   * `$room<CounterRoom>('counter:global').on('counter:updated', data => ...)` */
  <T = TEvents>(roomId: string): RoomHandle<any, InferRoomEvents<T>>
  readonly id: string | null
  readonly joined: boolean
  readonly state: TState
  join: (initialState?: TState) => Promise<void>
  leave: () => Promise<void>
  emit: <K extends keyof TEvents>(event: K, data: TEvents[K]) => void
  on: <K extends keyof TEvents>(event: K, handler: EventHandler<TEvents[K]>) => Unsubscribe
  onSystem: (event: string, handler: EventHandler) => Unsubscribe
  setState: (updates: Partial<TState>) => void
  /**
   * Remove all handlers for an event, or all handlers across all events if no event is given.
   * For system events, you may pass either the plain name ('state:change') or the prefixed name ('$state:change').
   */
  removeAllListeners: (event?: keyof TEvents | string) => void
} & RoomStateFields<TState>

export interface RoomManagerOptions {
  componentId: string | null
  defaultRoom?: string
  sendMessage: (msg: any) => void
  sendMessageAndWait: (msg: any, timeout?: number) => Promise<any>
  onMessage: (handler: (msg: RoomServerMessage) => void) => Unsubscribe
  /** Optional: register for binary room frames (0x02 ROOM_EVENT, 0x03 ROOM_STATE) */
  onBinaryMessage?: (handler: (frame: Uint8Array) => void) => Unsubscribe
}

/** Client-side room manager. Framework-agnostic. */
export class RoomManager<TState = any, TEvents extends Record<string, any> = Record<string, any>> {
  private componentId: string | null
  private defaultRoom: string | null
  // Room lifecycle state (driven by the server). Can be cleared/recreated
  // without affecting consumer-registered handlers.
  private rooms = new Map<string, {
    joined: boolean
    state: TState
  }>()
  // Event handlers — decoupled from `this.rooms` so they survive unmount/remount
  // cycles, leave/rejoin, and transport reconnection. Only cleared explicitly
  // via the returned Unsubscribe, removeAllListeners(), or disposeRoom().
  private roomHandlers = new Map<string, Map<string, Set<EventHandler>>>()
  private handles = new Map<string, RoomHandle<TState, TEvents>>()
  private sendMessage: (msg: any) => void
  private sendMessageAndWait: (msg: any, timeout?: number) => Promise<any>
  private globalUnsubscribe: Unsubscribe | null = null
  private binaryUnsubscribe: Unsubscribe | null = null
  private onBinaryMessage: ((handler: (frame: Uint8Array) => void) => Unsubscribe) | null = null
  private onMessageFactory: ((handler: (msg: RoomServerMessage) => void) => Unsubscribe) | null = null

  constructor(options: RoomManagerOptions) {
    this.componentId = options.componentId
    this.defaultRoom = options.defaultRoom || null
    this.sendMessage = options.sendMessage
    this.sendMessageAndWait = options.sendMessageAndWait
    this.onBinaryMessage = options.onBinaryMessage ?? null
    this.onMessageFactory = options.onMessage
    this.globalUnsubscribe = options.onMessage((msg) => this.handleServerMessage(msg))
    if (options.onBinaryMessage) {
      this.binaryUnsubscribe = options.onBinaryMessage((frame) => this.handleBinaryFrame(frame))
    }
  }

  /** Re-subscribe message and binary handlers (needed after destroy/remount in React Strict Mode) */
  resubscribe(): void {
    if (!this.globalUnsubscribe && this.onMessageFactory) {
      this.globalUnsubscribe = this.onMessageFactory((msg) => this.handleServerMessage(msg))
    }
    if (!this.binaryUnsubscribe && this.onBinaryMessage) {
      this.binaryUnsubscribe = this.onBinaryMessage((frame) => this.handleBinaryFrame(frame))
    }
  }

  private handleServerMessage(msg: RoomServerMessage): void {
    if (msg.componentId !== this.componentId) return

    switch (msg.type) {
      case 'ROOM_EVENT':
      case 'ROOM_SYSTEM':
        // Dispatch directly — handlers live in this.roomHandlers (persistent)
        // and do not require an entry in this.rooms. This survives the window
        // between destroy() and the consumer calling $room(id) again.
        this.dispatchToHandlers(msg.roomId, msg.event, msg.data)
        break

      case 'ROOM_STATE': {
        // Server sends data: { state: actualChanges } — extract the actual changes
        const stateChanges = msg.data?.state ?? msg.data
        const room = this.getOrCreateRoom(msg.roomId)
        room.state = deepMerge(room.state as Record<string, any>, stateChanges) as TState
        this.dispatchToHandlers(msg.roomId, '$state:change', stateChanges)
        break
      }

      case 'ROOM_JOINED': {
        const room = this.getOrCreateRoom(msg.roomId)
        room.joined = true
        if (msg.data?.state) room.state = msg.data.state
        break
      }

      case 'ROOM_LEFT': {
        const room = this.rooms.get(msg.roomId)
        if (room) room.joined = false
        break
      }
    }
  }

  /** Handle binary room frames (0x02 ROOM_EVENT, 0x03 ROOM_STATE) */
  private handleBinaryFrame(frame: Uint8Array): void {
    const parsed = parseRoomFrame(frame)
    if (!parsed) {
      return
    }
    if (parsed.componentId !== this.componentId) {
      return
    }

    // Decode defensively: a corrupt/truncated/deeply-nested frame must not crash
    // the client. Fail loud in the console, drop the frame gracefully.
    let data: unknown
    try {
      data = msgpackDecode(parsed.payload)
    } catch (err) {
      console.warn('[live-client] dropped a corrupt binary room frame:', err)
      return
    }

    if (parsed.frameType === BINARY_ROOM_EVENT) {
      // Dispatch directly — handlers live in this.roomHandlers (persistent)
      // and do not require an entry in this.rooms. This survives the window
      // between destroy() and the consumer calling $room(id) again.
      this.dispatchToHandlers(parsed.roomId, parsed.event, data)
    } else if (parsed.frameType === BINARY_ROOM_STATE) {
      // State update: data is { state: changes } or just changes
      const stateChanges = (data as any)?.state ?? data
      const room = this.getOrCreateRoom(parsed.roomId)
      room.state = deepMerge(room.state as Record<string, any>, stateChanges as Record<string, any>) as TState
      this.dispatchToHandlers(parsed.roomId, '$state:change', stateChanges)
    }
  }

  /** Dispatch to handlers registered in this.roomHandlers (decoupled from this.rooms). */
  private dispatchToHandlers(roomId: string, event: string, data: unknown): void {
    const handlers = this.roomHandlers.get(roomId)?.get(event)
    if (!handlers) return
    for (const handler of handlers) {
      try { handler(data) } catch (error) {
        console.error(`[Room:${roomId}] Handler error for '${event}':`, error)
      }
    }
  }

  private getOrCreateRoom(roomId: string) {
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, {
        joined: false,
        state: {} as TState,
      })
    }
    return this.rooms.get(roomId)!
  }

  private getOrCreateHandlers(roomId: string): Map<string, Set<EventHandler>> {
    let map = this.roomHandlers.get(roomId)
    if (!map) {
      map = new Map()
      this.roomHandlers.set(roomId, map)
    }
    return map
  }

  /** Create handle for a specific room (cached) */
  createHandle(roomId: string): RoomHandle<TState, TEvents> {
    if (this.handles.has(roomId)) return this.handles.get(roomId)!

    // Always resolve the room lazily at call time — never capture the object.
    // destroy() clears this.rooms, so a captured reference would become orphaned
    // while handleBinaryFrame/handleServerMessage look up a fresh object in the
    // Map (see issue #27).
    const getRoom = () => this.getOrCreateRoom(roomId)
    // Eagerly create the room entry so incoming JSON/binary messages find it
    // in this.rooms even before the first handle method is called.
    getRoom()

    // RoomStateFields are fulfilled at runtime by the Proxy wrapper
    const handle = {
      get id() { return roomId },
      get joined() { return getRoom().joined },
      get state() { return getRoom().state },

      join: async (initialState?: TState) => {
        if (!this.componentId) throw new Error('Component not mounted')
        const room = getRoom()
        if (room.joined) return

        if (initialState) room.state = initialState

        const response = await this.sendMessageAndWait({
          type: 'ROOM_JOIN',
          componentId: this.componentId,
          roomId,
          data: { initialState: room.state },
          timestamp: Date.now(),
        }, 5000)

        if (response?.success) {
          // Re-resolve: the room could have been recreated while we awaited.
          const current = getRoom()
          current.joined = true
          if (response.state) current.state = response.state
        }
      },

      leave: async () => {
        const room = getRoom()
        if (!this.componentId || !room.joined) return

        await this.sendMessageAndWait({
          type: 'ROOM_LEAVE',
          componentId: this.componentId,
          roomId,
          timestamp: Date.now(),
        }, 5000)

        // Only flip joined state. Handlers live in this.roomHandlers and must
        // survive leave/rejoin cycles — the consumer controls their lifetime
        // via the returned Unsubscribe, removeAllListeners(), or disposeRoom().
        getRoom().joined = false
      },

      emit: <K extends keyof TEvents>(event: K, data: TEvents[K]) => {
        if (!this.componentId) return
        this.sendMessage({
          type: 'ROOM_EMIT',
          componentId: this.componentId,
          roomId,
          event: event as string,
          data,
          timestamp: Date.now(),
        })
      },

      on: <K extends keyof TEvents>(event: K, handler: EventHandler<TEvents[K]>): Unsubscribe => {
        const eventKey = event as string
        const map = this.getOrCreateHandlers(roomId)
        if (!map.has(eventKey)) map.set(eventKey, new Set())
        map.get(eventKey)!.add(handler)
        return () => {
          this.roomHandlers.get(roomId)?.get(eventKey)?.delete(handler)
        }
      },

      onSystem: (event: string, handler: EventHandler): Unsubscribe => {
        const eventKey = `$${event}`
        const map = this.getOrCreateHandlers(roomId)
        if (!map.has(eventKey)) map.set(eventKey, new Set())
        map.get(eventKey)!.add(handler)
        return () => { this.roomHandlers.get(roomId)?.get(eventKey)?.delete(handler) }
      },

      setState: (updates: Partial<TState>) => {
        if (!this.componentId) return
        const room = getRoom()
        room.state = deepMerge(room.state as Record<string, any>, updates as Record<string, any>) as TState
        this.sendMessage({
          type: 'ROOM_STATE_SET',
          componentId: this.componentId,
          roomId,
          data: updates,
          timestamp: Date.now(),
        })
      },

      removeAllListeners: (event?: keyof TEvents | string) => {
        const map = this.roomHandlers.get(roomId)
        if (!map) return
        if (event === undefined) {
          map.clear()
          return
        }
        const key = event as string
        // Try as plain event first, then as a system event (with $ prefix) if
        // the caller passed e.g. 'state:change' instead of '$state:change'.
        map.get(key)?.clear()
        if (!key.startsWith('$')) map.get(`$${key}`)?.clear()
      },
    }

    const proxied = wrapWithStateProxy(
      handle,
      () => getRoom().state,
      (updates: Partial<TState>) => handle.setState(updates),
    )
    this.handles.set(roomId, proxied as RoomHandle<TState, TEvents>)
    return proxied as RoomHandle<TState, TEvents>
  }

  /** Create the $room proxy */
  createProxy(): RoomProxy<TState, TEvents> {
    const self = this

    const proxyFn = function(roomId: string): RoomHandle<TState, TEvents> {
      return self.createHandle(roomId)
    } as RoomProxy<TState, TEvents>

    const defaultHandle = this.defaultRoom ? this.createHandle(this.defaultRoom) : null

    Object.defineProperties(proxyFn, {
      id: { get: () => this.defaultRoom },
      joined: { get: () => defaultHandle?.joined ?? false },
      state: { get: () => defaultHandle?.state ?? ({} as TState) },
      join: {
        value: async (initialState?: TState) => {
          if (!defaultHandle) throw new Error('No default room set')
          return defaultHandle.join(initialState)
        },
      },
      leave: {
        value: async () => {
          if (!defaultHandle) throw new Error('No default room set')
          return defaultHandle.leave()
        },
      },
      emit: {
        value: <K extends keyof TEvents>(event: K, data: TEvents[K]) => {
          if (!defaultHandle) throw new Error('No default room set')
          return defaultHandle.emit(event, data)
        },
      },
      on: {
        value: <K extends keyof TEvents>(event: K, handler: EventHandler<TEvents[K]>): Unsubscribe => {
          if (!defaultHandle) throw new Error('No default room set')
          return defaultHandle.on(event, handler)
        },
      },
      onSystem: {
        value: (event: string, handler: EventHandler): Unsubscribe => {
          if (!defaultHandle) throw new Error('No default room set')
          return defaultHandle.onSystem(event, handler)
        },
      },
      setState: {
        value: (updates: Partial<TState>) => {
          if (!defaultHandle) throw new Error('No default room set')
          return defaultHandle.setState(updates)
        },
      },
      removeAllListeners: {
        value: (event?: keyof TEvents | string) => {
          if (!defaultHandle) throw new Error('No default room set')
          return defaultHandle.removeAllListeners(event)
        },
      },
    })

    // Wrap top-level proxy so $room.players reads from default room state.
    // Resolve the room lazily — capturing it here would go stale after destroy()
    // (see issue #27).
    if (this.defaultRoom && defaultHandle) {
      const defaultRoomId = this.defaultRoom
      return wrapWithStateProxy(
        proxyFn,
        () => this.getOrCreateRoom(defaultRoomId).state,
        (updates: Partial<TState>) => defaultHandle.setState(updates),
      ) as RoomProxy<TState, TEvents>
    }

    return proxyFn
  }

  /** List of rooms currently joined */
  getJoinedRooms(): string[] {
    const joined: string[] = []
    for (const [id, room] of this.rooms) {
      if (room.joined) joined.push(id)
    }
    return joined
  }

  /** Update componentId (when component mounts) */
  setComponentId(id: string | null): void {
    this.componentId = id
  }

  /**
   * Transport cleanup for unmount/remount cycles (e.g. React Strict Mode).
   *
   * Unsubscribes from the transport and clears room/handle caches, but
   * PRESERVES consumer-registered handlers (this.roomHandlers). This matches
   * the natural React pattern where handlers are registered inside useEffect
   * and cleaned up via the effect's return function — not by the framework.
   *
   * Call `resubscribe()` on remount to re-wire the transport. Call
   * `disposeRoom(roomId)` or `removeAllListeners()` on a handle to explicitly
   * drop handlers when the consumer is truly done with a room.
   *
   * Breaking change in v0.9.0 (issue #28): prior versions wiped handlers here,
   * which silently dropped callbacks across unmount/remount cycles.
   */
  destroy(): void {
    this.globalUnsubscribe?.()
    this.globalUnsubscribe = null
    this.binaryUnsubscribe?.()
    this.binaryUnsubscribe = null
    this.rooms.clear()
    this.handles.clear()
    // Intentionally NOT clearing this.roomHandlers — see doc above.
  }

  /**
   * Explicitly drop all state and handlers for a single room. Use this when
   * the consumer is truly finished with a room (not just unmounting).
   */
  disposeRoom(roomId: string): void {
    this.rooms.delete(roomId)
    this.handles.delete(roomId)
    this.roomHandlers.delete(roomId)
  }

  /**
   * Drop everything — transport, rooms, handles, handlers. Terminal; the
   * manager becomes unusable after this.
   */
  disposeAll(): void {
    this.destroy()
    this.roomHandlers.clear()
  }
}

export type { EventHandler, Unsubscribe }
