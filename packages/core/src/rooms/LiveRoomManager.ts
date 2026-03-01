// @fluxstack/live - Live Room Manager
//
// Manages rooms for Live Components. Uses RoomEventBus for server-side pub/sub.

import type { RoomEventBus } from './RoomEventBus'
import type { GenericWebSocket } from '../transport/types'
import { liveLog } from '../debug/LiveLogger'
import { MAX_ROOM_STATE_SIZE } from '../protocol/constants'

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
}

export class LiveRoomManager {
  private rooms = new Map<string, Room>()
  private componentRooms = new Map<string, Set<string>>() // componentId -> roomIds

  constructor(private roomEvents: RoomEventBus) {}

  /**
   * Component joins a room
   */
  joinRoom<TState = any>(componentId: string, roomId: string, ws: GenericWebSocket, initialState?: TState): { state: TState } {
    // Validate room name format
    if (!roomId || !/^[a-zA-Z0-9_:.-]{1,64}$/.test(roomId)) {
      throw new Error('Invalid room name. Must be 1-64 alphanumeric characters, hyphens, underscores, dots, or colons.')
    }

    // Create room if it doesn't exist
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, {
        id: roomId,
        state: initialState || {},
        members: new Map(),
        createdAt: Date.now(),
        lastActivity: Date.now()
      })
      liveLog('rooms', componentId, `Room '${roomId}' created`)
    }

    const room = this.rooms.get(roomId)!

    // Add member
    room.members.set(componentId, {
      componentId,
      ws,
      joinedAt: Date.now()
    })
    room.lastActivity = Date.now()

    // Track component rooms
    if (!this.componentRooms.has(componentId)) {
      this.componentRooms.set(componentId, new Set())
    }
    this.componentRooms.get(componentId)!.add(roomId)

    liveLog('rooms', componentId, `Component '${componentId}' joined room '${roomId}' (${room.members.size} members)`)

    // Notify other members
    this.broadcastToRoom(roomId, {
      type: 'ROOM_SYSTEM',
      componentId,
      roomId,
      event: '$sub:join',
      data: {
        subscriberId: componentId,
        count: room.members.size
      },
      timestamp: Date.now()
    }, componentId)

    return { state: room.state }
  }

  /**
   * Component leaves a room
   */
  leaveRoom(componentId: string, roomId: string): void {
    const room = this.rooms.get(roomId)
    if (!room) return

    room.members.delete(componentId)
    room.lastActivity = Date.now()

    this.componentRooms.get(componentId)?.delete(roomId)

    liveLog('rooms', componentId, `Component '${componentId}' left room '${roomId}' (${room.members.size} members)`)

    // Notify other members
    this.broadcastToRoom(roomId, {
      type: 'ROOM_SYSTEM',
      componentId,
      roomId,
      event: '$sub:leave',
      data: {
        subscriberId: componentId,
        count: room.members.size
      },
      timestamp: Date.now()
    })

    // Cleanup empty room after delay
    if (room.members.size === 0) {
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
   * Component disconnects - leave all rooms
   */
  cleanupComponent(componentId: string): void {
    const rooms = this.componentRooms.get(componentId)
    if (!rooms) return

    for (const roomId of rooms) {
      this.leaveRoom(componentId, roomId)
    }

    this.componentRooms.delete(componentId)
  }

  /**
   * Emit event to all members in a room
   */
  emitToRoom(roomId: string, event: string, data: any, excludeComponentId?: string): number {
    const room = this.rooms.get(roomId)
    if (!room) return 0

    room.lastActivity = Date.now()

    // 1. Emit on RoomEventBus for server-side handlers
    this.roomEvents.emit('room', roomId, event, data, excludeComponentId)

    // 2. Broadcast via WebSocket to frontends
    return this.broadcastToRoom(roomId, {
      type: 'ROOM_EVENT',
      componentId: '',
      roomId,
      event,
      data,
      timestamp: Date.now()
    }, excludeComponentId)
  }

  /**
   * Update room state
   */
  setRoomState(roomId: string, updates: any, excludeComponentId?: string): void {
    const room = this.rooms.get(roomId)
    if (!room) return

    const newState = { ...room.state, ...updates }

    // Validate state size
    const stateSize = Buffer.byteLength(JSON.stringify(newState), 'utf8')
    if (stateSize > MAX_ROOM_STATE_SIZE) {
      throw new Error('Room state exceeds maximum size limit')
    }

    room.state = newState
    room.lastActivity = Date.now()

    this.broadcastToRoom(roomId, {
      type: 'ROOM_STATE',
      componentId: '',
      roomId,
      event: '$state:update',
      data: { state: updates },
      timestamp: Date.now()
    }, excludeComponentId)
  }

  /**
   * Get room state
   */
  getRoomState<TState = any>(roomId: string): TState {
    return (this.rooms.get(roomId)?.state || {}) as TState
  }

  /**
   * Broadcast to all members in a room
   */
  private broadcastToRoom(roomId: string, message: any, excludeComponentId?: string): number {
    const room = this.rooms.get(roomId)
    if (!room) return 0

    let sent = 0
    for (const [componentId, member] of room.members) {
      if (excludeComponentId && componentId === excludeComponentId) continue

      try {
        if (member.ws && member.ws.readyState === 1) {
          member.ws.send(JSON.stringify({
            ...message,
            componentId
          }))
          sent++
        }
      } catch (error) {
        console.error(`Failed to send to ${componentId}:`, error)
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
