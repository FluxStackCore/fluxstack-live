// @fluxstack/live - Live Room Manager
//
// Manages rooms for Live Components. Uses RoomEventBus for server-side pub/sub.

import type { RoomEventBus } from './RoomEventBus'
import type { GenericWebSocket } from '../transport/types'
import { queueWsMessage, queuePreSerialized } from '../transport/WsSendBatcher'
import { liveLog } from '../debug/LiveLogger'
import { MAX_ROOM_STATE_SIZE, ROOM_NAME_REGEX } from '../protocol/constants'
import type { IRoomPubSubAdapter } from './adapters'
import { computeDeepDiff, deepAssign } from '../utils/deepDiff'

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
}

export class LiveRoomManager {
  private rooms = new Map<string, Room>()
  private componentRooms = new Map<string, Set<string>>() // componentId -> roomIds

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
   * Component joins a room
   * @param options.deepDiff - Enable/disable deep diff for this room's state. Default: true
   */
  joinRoom<TState = any>(componentId: string, roomId: string, ws: GenericWebSocket, initialState?: TState, options?: { deepDiff?: boolean; deepDiffDepth?: number }): { state: TState } {
    // Validate room name format (uses pre-compiled regex from constants)
    if (!roomId || !ROOM_NAME_REGEX.test(roomId)) {
      throw new Error('Invalid room name. Must be 1-64 alphanumeric characters, hyphens, underscores, dots, or colons.')
    }

    const now = Date.now()

    // Create room if it doesn't exist
    let room = this.rooms.get(roomId)
    if (!room) {
      room = {
        id: roomId,
        state: (initialState || {}) as TState,
        members: new Map(),
        createdAt: now,
        lastActivity: now,
        deepDiff: options?.deepDiff ?? true,
        deepDiffDepth: options?.deepDiffDepth ?? 3,
      }
      this.rooms.set(roomId, room)
      liveLog('rooms', componentId, `Room '${roomId}' created`)
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
   */
  leaveRoom(componentId: string, roomId: string): void {
    const room = this.rooms.get(roomId)
    if (!room) return

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
          this.rooms.delete(roomId)
          liveLog('rooms', null, `Room '${roomId}' destroyed (empty)`)
        }
      }, 5 * 60 * 1000)
    }
  }

  /**
   * Component disconnects - leave all rooms.
   * Batches removals: removes member from all rooms first,
   * then sends leave notifications in bulk.
   */
  cleanupComponent(componentId: string): void {
    const roomIds = this.componentRooms.get(componentId)
    if (!roomIds || roomIds.size === 0) return

    const now = Date.now()
    const notifications: { roomId: string; count: number }[] = []

    // Phase 1: Remove member from all rooms (no broadcasts yet)
    for (const roomId of roomIds) {
      const room = this.rooms.get(roomId)
      if (!room) continue

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
            this.rooms.delete(roomId)
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
   * Emit event to all members in a room
   */
  emitToRoom(roomId: string, event: string, data: any, excludeComponentId?: string): number {
    const room = this.rooms.get(roomId)
    if (!room) return 0

    const now = Date.now()
    room.lastActivity = now

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

    // Size check: estimate via update delta instead of full state re-serialization.
    if (room.stateSize === undefined) {
      const fullJson = JSON.stringify(room.state)
      room.stateSize = fullJson.length
      if (room.stateSize > MAX_ROOM_STATE_SIZE) {
        throw new Error('Room state exceeds maximum size limit')
      }
    } else {
      const deltaSize = JSON.stringify(actualChanges).length
      room.stateSize += deltaSize
      if (room.stateSize > MAX_ROOM_STATE_SIZE) {
        // Re-check precisely if we're near the limit
        const precise = JSON.stringify(room.state).length
        room.stateSize = precise
        if (precise > MAX_ROOM_STATE_SIZE) {
          throw new Error('Room state exceeds maximum size limit')
        }
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
   * Serializes the message ONCE and sends the same string to all members.
   */
  private broadcastToRoom(roomId: string, message: any, excludeComponentId?: string): number {
    const room = this.rooms.get(roomId)
    if (!room || room.members.size === 0) return 0

    // Pre-serialize once for all members
    const serialized = JSON.stringify(message)

    let sent = 0

    if (excludeComponentId) {
      for (const [componentId, member] of room.members) {
        if (componentId === excludeComponentId) continue
        if (member.ws.readyState === 1) {
          queuePreSerialized(member.ws, serialized)
          sent++
        }
      }
    } else {
      // Fast path: no exclusion, iterate values only
      for (const member of room.members.values()) {
        if (member.ws.readyState === 1) {
          queuePreSerialized(member.ws, serialized)
          sent++
        }
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
   * Get rooms for a component
   */
  getComponentRooms(componentId: string): string[] {
    return Array.from(this.componentRooms.get(componentId) || [])
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
