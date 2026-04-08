// @fluxstack/live - Live Room Manager
//
// Manages rooms for Live Components. Uses RoomEventBus for server-side pub/sub.

import type { RoomEventBus } from './RoomEventBus'
import type { GenericWebSocket } from '../transport/types'
import { queueWsMessage, queuePreSerialized, sendBinaryImmediate } from '../transport/WsSendBatcher'
import { liveLog } from '../debug/LiveLogger'
import { MAX_ROOM_STATE_SIZE, ROOM_NAME_REGEX } from '../protocol/constants'
import type { IRoomPubSubAdapter } from './adapters'
import { computeDeepDiff, deepAssign } from '../utils/deepDiff'
import type { LiveRoom } from './LiveRoom'
import type { RoomRegistry } from './RoomRegistry'
import {
  resolveCodec,
  buildRoomFrameTail,
  prependMemberHeader,
  BINARY_ROOM_EVENT,
  BINARY_ROOM_STATE,
  type RoomCodec,
} from './RoomCodec'

export interface RoomMessage {
  type: 'ROOM_JOIN' | 'ROOM_LEAVE' | 'ROOM_EMIT' | 'ROOM_STATE_SET' | 'ROOM_STATE_GET'
  componentId: string
  roomId: string
  event?: string
  data?: any
  requestId?: string
  timestamp: number
}

interface RoomMember {
  componentId: string
  ws: GenericWebSocket
  joinedAt: number
}

interface Room<TState = any> {
  id: string
  state: TState
  members: Map<string, RoomMember>
  createdAt: number
  lastActivity: number
  /** Estimated serialized state size in bytes (for size limit checks) */
  stateSize?: number
  /** Whether deep diff is enabled for this room's state. Default: true */
  deepDiff: boolean
  /** Max recursion depth for deep diff. Default: 3 */
  deepDiffDepth: number
  /** When true, only server-side code can set room state. Client ROOM_STATE_SET is rejected. Default: false */
  serverOnlyState: boolean
  /** Update counter for periodic size recalculation */
  _updateCount?: number
  /** LiveRoom instance when backed by a typed room class */
  instance?: LiveRoom<any, any, any>
  /** Resolved binary codec for this room. null = JSON text mode (legacy rooms). */
  codec: RoomCodec | null
}

export class LiveRoomManager {
  private rooms = new Map<string, Room>()
  private componentRooms = new Map<string, Set<string>>() // componentId -> roomIds

  /** Room registry for LiveRoom class lookup. Set by LiveServer. */
  public roomRegistry?: RoomRegistry

  /**
   * @param roomEvents - Local server-side event bus
   * @param pubsub - Optional cross-instance pub/sub adapter (e.g. Redis).
   *                 When provided, room events/state/membership are propagated
   *                 to other server instances in the background.
   */
  constructor(
    private roomEvents: RoomEventBus,
    private pubsub?: IRoomPubSubAdapter,
  ) {}

  /**
   * Component joins a room.
   * @param options.deepDiff - Enable/disable deep diff for this room's state. Default: true
   * @param joinContext - Optional context for LiveRoom lifecycle hooks (userId, payload)
   */
  async joinRoom<TState = any>(
    componentId: string,
    roomId: string,
    ws: GenericWebSocket,
    initialState?: TState,
    options?: { deepDiff?: boolean; deepDiffDepth?: number; serverOnlyState?: boolean },
    joinContext?: { userId?: string; payload?: any },
  ): Promise<{ state: TState; rejected?: false } | { rejected: true; reason: string }> {
    // Validate room name format (uses pre-compiled regex from constants)
    if (!roomId || !ROOM_NAME_REGEX.test(roomId)) {
      throw new Error('Invalid room name. Must be 1-64 alphanumeric characters, hyphens, underscores, dots, or colons.')
    }

    const now = Date.now()

    // Create room if it doesn't exist
    let room = this.rooms.get(roomId)
    let isNewRoom = false

    if (!room) {
      isNewRoom = true

      // Check if a LiveRoom class is registered for this room type
      const roomClass = this.roomRegistry?.resolveFromId(roomId)

      if (roomClass) {
        const instance = new roomClass(roomId, this as any)
        const opts = roomClass.$options ?? {}

        room = {
          id: roomId,
          state: instance.state,
          members: new Map(),
          createdAt: now,
          lastActivity: now,
          deepDiff: opts.deepDiff ?? true,
          deepDiffDepth: opts.deepDiffDepth ?? 3,
          serverOnlyState: true, // LiveRoom-backed rooms are always server-only
          instance,
          codec: resolveCodec(opts.codec),
        }
      } else {
        // Legacy untyped room — no binary codec (JSON text mode)
        room = {
          id: roomId,
          state: (initialState || {}) as TState,
          members: new Map(),
          createdAt: now,
          lastActivity: now,
          deepDiff: options?.deepDiff ?? true,
          deepDiffDepth: options?.deepDiffDepth ?? 3,
          serverOnlyState: options?.serverOnlyState ?? false,
          codec: null,
        }
      }

      this.rooms.set(roomId, room)
      liveLog('rooms', componentId, `Room '${roomId}' created`)
    }

    // Check maxMembers limit for LiveRoom-backed rooms
    if (room.instance) {
      const ctor = room.instance.constructor as typeof LiveRoom & { $options?: { maxMembers?: number } }
      const maxMembers = ctor.$options?.maxMembers
      if (maxMembers && room.members.size >= maxMembers) {
        return { rejected: true, reason: 'Room is full' }
      }
    }

    // Call onJoin lifecycle hook for LiveRoom-backed rooms
    if (room.instance) {
      const result = await room.instance.onJoin({
        componentId,
        userId: joinContext?.userId,
        payload: joinContext?.payload,
      })

      // Handle rejection (sync or async)
      if (result === false) {
        // If this was a new room and join was rejected, clean up
        if (isNewRoom) {
          this.rooms.delete(roomId)
        }
        return { rejected: true, reason: 'Join rejected by room' }
      }
    }

    // Call onCreate for new LiveRoom instances (after onJoin succeeds)
    if (isNewRoom && room.instance) {
      room.instance.onCreate()
    }

    // Add member
    room.members.set(componentId, {
      componentId,
      ws,
      joinedAt: now
    })
    room.lastActivity = now

    // Track component rooms
    let compRooms = this.componentRooms.get(componentId)
    if (!compRooms) {
      compRooms = new Set()
      this.componentRooms.set(componentId, compRooms)
    }
    compRooms.add(roomId)

    const memberCount = room.members.size
    liveLog('rooms', componentId, `Component '${componentId}' joined room '${roomId}' (${memberCount} members)`)

    // Notify other members
    this.broadcastToRoom(roomId, {
      type: 'ROOM_SYSTEM',
      componentId,
      roomId,
      event: '$sub:join',
      data: {
        subscriberId: componentId,
        count: memberCount
      },
      timestamp: now
    }, componentId)

    // Propagate to other instances (fire-and-forget)
    this.pubsub?.publishMembership(roomId, 'join', componentId)?.catch(() => {})

    return { state: room.state }
  }

  /**
   * Component leaves a room
   * @param leaveReason - Why the component is leaving. Default: 'leave'
   */
  async leaveRoom(componentId: string, roomId: string, leaveReason: 'leave' | 'disconnect' | 'cleanup' = 'leave'): Promise<void> {
    const room = this.rooms.get(roomId)
    if (!room) return

    // Call onLeave lifecycle hook for LiveRoom-backed rooms (await async cleanup)
    if (room.instance) {
      await room.instance.onLeave({
        componentId,
        reason: leaveReason,
      })
    }

    room.members.delete(componentId)

    const now = Date.now()
    room.lastActivity = now

    this.componentRooms.get(componentId)?.delete(roomId)

    const memberCount = room.members.size
    liveLog('rooms', componentId, `Component '${componentId}' left room '${roomId}' (${memberCount} members)`)

    // Notify other members
    this.broadcastToRoom(roomId, {
      type: 'ROOM_SYSTEM',
      componentId,
      roomId,
      event: '$sub:leave',
      data: {
        subscriberId: componentId,
        count: memberCount
      },
      timestamp: now
    })

    // Propagate to other instances (fire-and-forget)
    this.pubsub?.publishMembership(roomId, 'leave', componentId)?.catch(() => {})

    // Cleanup empty room after delay
    if (memberCount === 0) {
      setTimeout(() => {
        const currentRoom = this.rooms.get(roomId)
        if (currentRoom && currentRoom.members.size === 0) {
          // Call onDestroy for LiveRoom-backed rooms
          if (currentRoom.instance) {
            const result = currentRoom.instance.onDestroy()
            if (result === false) return // Room wants to stay alive
          }
          this.rooms.delete(roomId)
          liveLog('rooms', null, `Room '${roomId}' destroyed (empty)`)
        }
      }, 5 * 60 * 1000)
    }
  }

  /**
   * Component disconnects - leave all rooms.
   * Batches removals: calls onLeave hooks, removes member from all rooms,
   * then sends leave notifications in bulk.
   */
  async cleanupComponent(componentId: string): Promise<void> {
    const roomIds = this.componentRooms.get(componentId)
    if (!roomIds || roomIds.size === 0) return

    const now = Date.now()
    const notifications: { roomId: string; count: number }[] = []

    // Phase 1: Call onLeave hooks + remove member from all rooms (no broadcasts yet)
    for (const roomId of roomIds) {
      const room = this.rooms.get(roomId)
      if (!room) continue

      // Call onLeave lifecycle hook for LiveRoom-backed rooms (await async cleanup)
      if (room.instance) {
        await room.instance.onLeave({
          componentId,
          reason: 'disconnect',
        })
      }

      room.members.delete(componentId)
      room.lastActivity = now
      const memberCount = room.members.size

      // Collect notification data
      if (memberCount > 0) {
        notifications.push({ roomId, count: memberCount })
      } else {
        // Schedule empty room cleanup
        setTimeout(() => {
          const currentRoom = this.rooms.get(roomId)
          if (currentRoom && currentRoom.members.size === 0) {
            // Call onDestroy for LiveRoom-backed rooms
            if (currentRoom.instance) {
              const result = currentRoom.instance.onDestroy()
              if (result === false) return // Room wants to stay alive
            }
            this.rooms.delete(roomId)
            liveLog('rooms', null, `Room '${roomId}' destroyed (empty)`)
          }
        }, 5 * 60 * 1000)
      }
    }

    // Phase 2: Send leave notifications in batch
    for (const { roomId, count } of notifications) {
      this.broadcastToRoom(roomId, {
        type: 'ROOM_SYSTEM',
        componentId,
        roomId,
        event: '$sub:leave',
        data: {
          subscriberId: componentId,
          count
        },
        timestamp: now
      })
    }

    this.componentRooms.delete(componentId)
  }

  /**
   * Emit event to all members in a room.
   * For LiveRoom-backed rooms, calls onEvent() hook before broadcasting.
   */
  emitToRoom(roomId: string, event: string, data: any, excludeComponentId?: string): number {
    const room = this.rooms.get(roomId)
    if (!room) return 0

    const now = Date.now()
    room.lastActivity = now

    // 0. Call onEvent lifecycle hook for LiveRoom-backed rooms
    if (room.instance) {
      room.instance.onEvent(event, data, {
        componentId: excludeComponentId ?? 'server',
      })
    }

    // 1. Emit on RoomEventBus for server-side handlers
    this.roomEvents.emit('room', roomId, event, data, excludeComponentId)

    // 2. Propagate to other instances (fire-and-forget)
    this.pubsub?.publish(roomId, event, data)?.catch(() => {})

    // 3. Broadcast via WebSocket to frontends
    return this.broadcastToRoom(roomId, {
      type: 'ROOM_EVENT',
      componentId: '',
      roomId,
      event,
      data,
      timestamp: now
    }, excludeComponentId)
  }

  /**
   * Update room state.
   * When deepDiff is enabled (default), deep-diffs plain objects to send only changed fields.
   * When disabled, uses shallow diff (reference equality) like classic behavior.
   */
  setRoomState(roomId: string, updates: any, excludeComponentId?: string): void {
    const room = this.rooms.get(roomId)
    if (!room) return

    let actualChanges: Record<string, unknown>

    if (room.deepDiff) {
      // Deep diff: only send fields that actually changed
      const diff = computeDeepDiff(
        room.state as Record<string, unknown>,
        updates as Record<string, unknown>,
        0,
        room.deepDiffDepth,
      )
      if (diff === null) return // nothing changed
      actualChanges = diff

      // Mutate in-place with recursive merge
      deepAssign(room.state, actualChanges)
    } else {
      // Shallow diff: reference equality
      actualChanges = {}
      let hasChanges = false
      for (const key of Object.keys(updates)) {
        if (room.state[key] !== updates[key]) {
          actualChanges[key] = updates[key]
          hasChanges = true
        }
      }
      if (!hasChanges) return

      Object.assign(room.state, actualChanges)
    }

    // Size check: recalculate actual size every 10 updates to prevent drift,
    // and always on first update or when approaching the limit.
    if (!room._updateCount) room._updateCount = 0
    room._updateCount++

    const shouldRecalculate = room.stateSize === undefined || room._updateCount % 10 === 0
    if (shouldRecalculate) {
      room.stateSize = JSON.stringify(room.state).length
    } else {
      // Rough estimate between recalculations
      const deltaSize = JSON.stringify(actualChanges).length
      room.stateSize = (room.stateSize ?? 0) + deltaSize
    }

    if ((room.stateSize ?? 0) > MAX_ROOM_STATE_SIZE) {
      // Always re-check precisely before rejecting
      const precise = JSON.stringify(room.state).length
      room.stateSize = precise
      if (precise > MAX_ROOM_STATE_SIZE) {
        throw new Error('Room state exceeds maximum size limit')
      }
    }

    const now = Date.now()
    room.lastActivity = now

    // Propagate state change to other instances (fire-and-forget)
    this.pubsub?.publishStateChange(roomId, actualChanges)?.catch(() => {})

    this.broadcastToRoom(roomId, {
      type: 'ROOM_STATE',
      componentId: '',
      roomId,
      event: '$state:update',
      data: { state: actualChanges },
      timestamp: now
    }, excludeComponentId)
  }

  /**
   * Get room state
   */
  getRoomState<TState = any>(roomId: string): TState {
    return (this.rooms.get(roomId)?.state || {}) as TState
  }

  /**
   * Broadcast to all members in a room.
   *
   * When the room has a binary codec (LiveRoom-backed), builds a binary frame
   * once (encode payload + frame tail), then prepends per-member componentId header.
   *
   * When no codec (legacy rooms), uses JSON with serialize-once optimization:
   * builds the JSON string template once, then inserts each member's componentId.
   */
  private broadcastToRoom(roomId: string, message: any, excludeComponentId?: string): number {
    const room = this.rooms.get(roomId)
    if (!room || room.members.size === 0) return 0

    let sent = 0

    if (room.codec) {
      // Binary path: encode payload once, build shared tail, prepend per-member header
      const frameType = message.type === 'ROOM_EVENT' || message.type === 'ROOM_SYSTEM'
        ? BINARY_ROOM_EVENT
        : BINARY_ROOM_STATE
      const event = message.event ?? ''
      const payload = room.codec.encode(message.data)
      const tail = buildRoomFrameTail(roomId, event, payload)

      for (const [memberComponentId, member] of room.members) {
        if (memberComponentId === excludeComponentId) continue
        if (member.ws.readyState !== 1) continue
        const frame = prependMemberHeader(frameType, memberComponentId, tail)
        sendBinaryImmediate(member.ws, frame)
        sent++
      }
    } else {
      // JSON text path: serialize once without componentId, then splice per member
      // Build template: {"type":"...","componentId":"","roomId":"...","event":"...","data":...,"timestamp":...}
      const { componentId: _, ...rest } = message
      const jsonBody = JSON.stringify(rest)
      // Insert componentId field after the opening brace
      // Template: '{"componentId":"<PLACEHOLDER>",...rest}'
      const prefix = '{"componentId":"'
      const suffix = '",' + jsonBody.slice(1) // skip the opening brace of rest

      for (const [memberComponentId, member] of room.members) {
        if (memberComponentId === excludeComponentId) continue
        if (member.ws.readyState !== 1) continue
        queuePreSerialized(member.ws, prefix + memberComponentId + suffix)
        sent++
      }
    }

    return sent
  }

  /**
   * Check if component is in a room
   */
  isInRoom(componentId: string, roomId: string): boolean {
    return this.rooms.get(roomId)?.members.has(componentId) ?? false
  }

  /**
   * Check if room state is server-only (no client writes)
   */
  isServerOnlyState(roomId: string): boolean {
    return this.rooms.get(roomId)?.serverOnlyState ?? false
  }

  /**
   * Get rooms for a component
   */
  getComponentRooms(componentId: string): string[] {
    return Array.from(this.componentRooms.get(componentId) || [])
  }

  /**
   * Get member count for a room
   */
  getMemberCount(roomId: string): number {
    return this.rooms.get(roomId)?.members.size ?? 0
  }

  /**
   * Get the LiveRoom instance for a room (if backed by a typed room class).
   * Used by ComponentRoomProxy to expose custom methods.
   */
  getRoomInstance(roomId: string): LiveRoom<any, any, any> | undefined {
    return this.rooms.get(roomId)?.instance
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalRooms: number
    rooms: Record<string, { members: number; createdAt: number; lastActivity: number }>
  } {
    const rooms: Record<string, { members: number; createdAt: number; lastActivity: number }> = {}

    for (const [id, room] of this.rooms) {
      rooms[id] = {
        members: room.members.size,
        createdAt: room.createdAt,
        lastActivity: room.lastActivity
      }
    }

    return {
      totalRooms: this.rooms.size,
      rooms
    }
  }
}

export type { Room, RoomMember }
