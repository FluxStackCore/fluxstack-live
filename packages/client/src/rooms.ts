// @fluxstack/live-client - Room Manager (Client-side)
//
// Framework-agnostic room system for managing multi-room WebSocket communication.
// Used by framework-specific adapters (React, Vue, etc.).

type EventHandler<T = any> = (data: T) => void
type Unsubscribe = () => void

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
export interface RoomHandle<TState = any, TEvents extends Record<string, any> = Record<string, any>> {
  readonly id: string
  readonly joined: boolean
  readonly state: TState
  join: (initialState?: TState) => Promise<void>
  leave: () => Promise<void>
  emit: <K extends keyof TEvents>(event: K, data: TEvents[K]) => void
  on: <K extends keyof TEvents>(event: K, handler: EventHandler<TEvents[K]>) => Unsubscribe
  onSystem: (event: string, handler: EventHandler) => Unsubscribe
  setState: (updates: Partial<TState>) => void
}

/** Proxy interface for $room - callable as function or object */
export interface RoomProxy<TState = any, TEvents extends Record<string, any> = Record<string, any>> {
  (roomId: string): RoomHandle<TState, TEvents>
  readonly id: string | null
  readonly joined: boolean
  readonly state: TState
  join: (initialState?: TState) => Promise<void>
  leave: () => Promise<void>
  emit: <K extends keyof TEvents>(event: K, data: TEvents[K]) => void
  on: <K extends keyof TEvents>(event: K, handler: EventHandler<TEvents[K]>) => Unsubscribe
  onSystem: (event: string, handler: EventHandler) => Unsubscribe
  setState: (updates: Partial<TState>) => void
}

export interface RoomManagerOptions {
  componentId: string | null
  defaultRoom?: string
  sendMessage: (msg: any) => void
  sendMessageAndWait: (msg: any, timeout?: number) => Promise<any>
  onMessage: (handler: (msg: RoomServerMessage) => void) => Unsubscribe
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

  constructor(options: RoomManagerOptions) {
    this.componentId = options.componentId
    this.defaultRoom = options.defaultRoom || null
    this.sendMessage = options.sendMessage
    this.sendMessageAndWait = options.sendMessageAndWait
    this.globalUnsubscribe = options.onMessage((msg) => this.handleServerMessage(msg))
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
        room.state = { ...room.state, ...msg.data }
        const stateHandlers = room.handlers.get('$state:change')
        if (stateHandlers) {
          for (const handler of stateHandlers) handler(msg.data)
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

    const handle: RoomHandle<TState, TEvents> = {
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
        room.state = { ...room.state, ...updates }
        this.sendMessage({
          type: 'ROOM_STATE_SET',
          componentId: this.componentId,
          roomId,
          data: updates,
          timestamp: Date.now(),
        })
      },
    }

    this.handles.set(roomId, handle)
    return handle
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

  /** Cleanup */
  destroy(): void {
    this.globalUnsubscribe?.()
    for (const [, room] of this.rooms) {
      room.handlers.clear()
    }
    this.rooms.clear()
    this.handles.clear()
  }
}

export type { EventHandler, Unsubscribe }
