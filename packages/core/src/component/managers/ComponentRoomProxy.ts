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
import type { LiveComponentContext, LiveDebuggerInterface } from '../context'
import type { ServerRoomHandle, ServerRoomProxy } from '../../protocol/messages'
import { liveLog, liveWarn } from '../../debug/LiveLogger'

export interface RoomProxyContext {
  componentId: string
  ws: GenericWebSocket
  defaultRoom?: string
  /** Lazy getter — only called when room features are used */
  getCtx: () => LiveComponentContext
  debugger?: LiveDebuggerInterface | null
  setStateFn: (updates: any) => void
  /** Deep diff setting for rooms (from component $options). Default: true */
  deepDiff?: boolean
  /** Max recursion depth for deep diff. Default: 3 */
  deepDiffDepth?: number
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
  private _debugger: LiveDebuggerInterface | null
  private setStateFn: (updates: any) => void
  private _deepDiff: boolean
  private _deepDiffDepth: number | undefined

  constructor(rctx: RoomProxyContext) {
    this.componentId = rctx.componentId
    this.ws = rctx.ws
    this.room = rctx.defaultRoom
    this.getCtx = rctx.getCtx
    this._debugger = rctx.debugger ?? null
    this.setStateFn = rctx.setStateFn
    this._deepDiff = rctx.deepDiff ?? true
    this._deepDiffDepth = rctx.deepDiffDepth

    // Auto-join default room if specified
    if (this.room) {
      this.joinedRooms.add(this.room)
      this.ctx.roomManager.joinRoom(this.componentId, this.room, this.ws, undefined, { deepDiff: this._deepDiff, deepDiffDepth: this._deepDiffDepth })
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
          self.ctx.roomManager.joinRoom(self.componentId, roomId, self.ws, initialState, { deepDiff: self._deepDiff, deepDiffDepth: self._deepDiffDepth })
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

    this._roomProxy = proxyFn
    return proxyFn
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

    this._debugger?.trackRoomEmit(this.componentId, this.room, event, data)

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
