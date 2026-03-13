// @fluxstack/live-client - Room Manager (Client-side)
//
// Framework-agnostic room system for managing multi-room WebSocket communication.
// Used by framework-specific adapters (React, Vue, etc.).

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

type EventHandler<T = any> = (data: T) => void
type Unsubscribe = () => void

// ===== Binary Room Frame Constants =====

const BINARY_ROOM_EVENT = 0x02
const BINARY_ROOM_STATE = 0x03

// ===== Lightweight msgpack decoder (client-side, decode-only) =====

const _decoder = new TextDecoder()

function msgpackDecode(buf: Uint8Array): unknown {
  return _decodeAt(buf, 0).value
}

function _decodeAt(buf: Uint8Array, offset: number): { value: unknown; offset: number } {
  if (offset >= buf.length) return { value: null, offset }
  const byte = buf[offset]
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)

  if (byte < 0x80) return { value: byte, offset: offset + 1 }
  if (byte >= 0x80 && byte <= 0x8f) return _decodeMap(buf, offset + 1, byte & 0x0f)
  if (byte >= 0x90 && byte <= 0x9f) return _decodeArr(buf, offset + 1, byte & 0x0f)
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
    case 0xdc: return _decodeArr(buf, offset + 3, view.getUint16(offset + 1, false))
    case 0xdd: return _decodeArr(buf, offset + 5, view.getUint32(offset + 1, false))
    case 0xde: return _decodeMap(buf, offset + 3, view.getUint16(offset + 1, false))
    case 0xdf: return _decodeMap(buf, offset + 5, view.getUint32(offset + 1, false))
  }
  return { value: null, offset: offset + 1 }
}

function _decodeArr(buf: Uint8Array, offset: number, count: number): { value: unknown[]; offset: number } {
  const arr: unknown[] = new Array(count)
  for (let i = 0; i < count; i++) { const r = _decodeAt(buf, offset); arr[i] = r.value; offset = r.offset }
  return { value: arr, offset }
}

function _decodeMap(buf: Uint8Array, offset: number, count: number): { value: Record<string, unknown>; offset: number } {
  const obj: Record<string, unknown> = {}
  for (let i = 0; i < count; i++) {
    const k = _decodeAt(buf, offset); offset = k.offset
    const v = _decodeAt(buf, offset); offset = v.offset
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
  'id', 'joined', 'state', 'join', 'leave', 'emit', 'on', 'onSystem', 'setState',
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
type RoomReservedKeys = 'id' | 'joined' | 'state' | 'join' | 'leave' | 'emit' | 'on' | 'onSystem' | 'setState'

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
  private rooms = new Map<string, {
    joined: boolean
    state: TState
    handlers: Map<string, Set<EventHandler>>
  }>()
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

    const room = this.rooms.get(msg.roomId)
    if (!room) return

    switch (msg.type) {
      case 'ROOM_EVENT':
      case 'ROOM_SYSTEM': {
        const handlers = room.handlers.get(msg.event)
        if (handlers) {
          for (const handler of handlers) {
            try { handler(msg.data) } catch (error) {
              console.error(`[Room:${msg.roomId}] Handler error for '${msg.event}':`, error)
            }
          }
        }
        break
      }

      case 'ROOM_STATE': {
        // Server sends data: { state: actualChanges } — extract the actual changes
        const stateChanges = msg.data?.state ?? msg.data
        room.state = deepMerge(room.state as Record<string, any>, stateChanges) as TState
        const stateHandlers = room.handlers.get('$state:change')
        if (stateHandlers) {
          for (const handler of stateHandlers) handler(stateChanges)
        }
        break
      }

      case 'ROOM_JOINED':
        room.joined = true
        if (msg.data?.state) room.state = msg.data.state
        break

      case 'ROOM_LEFT':
        room.joined = false
        break
    }
  }

  /** Handle binary room frames (0x02 ROOM_EVENT, 0x03 ROOM_STATE) */
  private handleBinaryFrame(frame: Uint8Array): void {
    const parsed = parseRoomFrame(frame)
    if (!parsed) return
    if (parsed.componentId !== this.componentId) return

    const room = this.rooms.get(parsed.roomId)
    if (!room) return

    const data = msgpackDecode(parsed.payload)

    if (parsed.frameType === BINARY_ROOM_EVENT) {
      // Dispatch to event handlers
      const handlers = room.handlers.get(parsed.event)
      if (handlers) {
        for (const handler of handlers) {
          try { handler(data) } catch (error) {
            console.error(`[Room:${parsed.roomId}] Handler error for '${parsed.event}':`, error)
          }
        }
      }
    } else if (parsed.frameType === BINARY_ROOM_STATE) {
      // State update: data is { state: changes } or just changes
      const stateChanges = (data as any)?.state ?? data
      room.state = deepMerge(room.state as Record<string, any>, stateChanges as Record<string, any>) as TState
      const stateHandlers = room.handlers.get('$state:change')
      if (stateHandlers) {
        for (const handler of stateHandlers) handler(stateChanges)
      }
    }
  }

  private getOrCreateRoom(roomId: string) {
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, {
        joined: false,
        state: {} as TState,
        handlers: new Map(),
      })
    }
    return this.rooms.get(roomId)!
  }

  /** Create handle for a specific room (cached) */
  createHandle(roomId: string): RoomHandle<TState, TEvents> {
    if (this.handles.has(roomId)) return this.handles.get(roomId)!

    const room = this.getOrCreateRoom(roomId)

    // RoomStateFields are fulfilled at runtime by the Proxy wrapper
    const handle = {
      get id() { return roomId },
      get joined() { return room.joined },
      get state() { return room.state },

      join: async (initialState?: TState) => {
        if (!this.componentId) throw new Error('Component not mounted')
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
          room.joined = true
          if (response.state) room.state = response.state
        }
      },

      leave: async () => {
        if (!this.componentId || !room.joined) return

        await this.sendMessageAndWait({
          type: 'ROOM_LEAVE',
          componentId: this.componentId,
          roomId,
          timestamp: Date.now(),
        }, 5000)

        room.joined = false
        room.handlers.clear()
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
        if (!room.handlers.has(eventKey)) room.handlers.set(eventKey, new Set())
        room.handlers.get(eventKey)!.add(handler)
        return () => { room.handlers.get(eventKey)?.delete(handler) }
      },

      onSystem: (event: string, handler: EventHandler): Unsubscribe => {
        const eventKey = `$${event}`
        if (!room.handlers.has(eventKey)) room.handlers.set(eventKey, new Set())
        room.handlers.get(eventKey)!.add(handler)
        return () => { room.handlers.get(eventKey)?.delete(handler) }
      },

      setState: (updates: Partial<TState>) => {
        if (!this.componentId) return
        room.state = deepMerge(room.state as Record<string, any>, updates as Record<string, any>) as TState
        this.sendMessage({
          type: 'ROOM_STATE_SET',
          componentId: this.componentId,
          roomId,
          data: updates,
          timestamp: Date.now(),
        })
      },
    }

    const proxied = wrapWithStateProxy(
      handle,
      () => room.state,
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
    })

    // Wrap top-level proxy so $room.players reads from default room state
    if (this.defaultRoom && defaultHandle) {
      const room = this.getOrCreateRoom(this.defaultRoom)
      return wrapWithStateProxy(
        proxyFn,
        () => room.state,
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

  /** Cleanup — unsubscribes handlers but keeps factory refs for resubscribe() */
  destroy(): void {
    this.globalUnsubscribe?.()
    this.globalUnsubscribe = null
    this.binaryUnsubscribe?.()
    this.binaryUnsubscribe = null
    for (const [, room] of this.rooms) {
      room.handlers.clear()
    }
    this.rooms.clear()
    this.handles.clear()
  }
}

export type { EventHandler, Unsubscribe }
