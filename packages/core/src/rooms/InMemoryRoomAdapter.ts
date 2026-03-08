// @fluxstack/live - In-Memory Room Adapter (Default)
//
// Single-instance, zero-dependency adapter for room storage and pub/sub.
// All operations resolve synchronously via Promise.resolve().
// Pub/sub methods are no-ops since all events are already local.

import type { IRoomStorageAdapter, IRoomPubSubAdapter } from './adapters'

interface RoomData {
  state: any
  createdAt: number
  lastUpdate: number
}

export class InMemoryRoomAdapter implements IRoomStorageAdapter, IRoomPubSubAdapter {
  private rooms = new Map<string, RoomData>()

  // ===== IRoomStorageAdapter =====

  async getOrCreateRoom(roomId: string, initialState?: any): Promise<{ state: any; created: boolean }> {
    const existing = this.rooms.get(roomId)
    if (existing) {
      return { state: existing.state, created: false }
    }

    const now = Date.now()
    const data: RoomData = {
      state: initialState ?? {},
      createdAt: now,
      lastUpdate: now,
    }
    this.rooms.set(roomId, data)
    return { state: data.state, created: true }
  }

  async getState(roomId: string): Promise<any> {
    return this.rooms.get(roomId)?.state ?? {}
  }

  async updateState(roomId: string, updates: any): Promise<void> {
    const room = this.rooms.get(roomId)
    if (room) {
      Object.assign(room.state, updates)
      room.lastUpdate = Date.now()
    }
  }

  async hasRoom(roomId: string): Promise<boolean> {
    return this.rooms.has(roomId)
  }

  async deleteRoom(roomId: string): Promise<boolean> {
    return this.rooms.delete(roomId)
  }

  async getStats(): Promise<{ totalRooms: number; rooms: Record<string, any> }> {
    const rooms: Record<string, any> = {}
    for (const [id, data] of this.rooms) {
      rooms[id] = {
        createdAt: data.createdAt,
        lastUpdate: data.lastUpdate,
        stateKeys: Object.keys(data.state),
      }
    }
    return { totalRooms: this.rooms.size, rooms }
  }

  // ===== IRoomPubSubAdapter =====
  // No-ops for single-instance: all events are already propagated locally
  // by RoomEventBus and LiveRoomManager's broadcastToRoom().

  async publish(_roomId: string, _event: string, _data: any): Promise<void> {
    // No-op: events are already local
  }

  async subscribe(_roomId: string, _handler: (event: string, data: any) => void): Promise<() => void> {
    // No-op: return empty unsubscribe
    return () => {}
  }

  async publishMembership(_roomId: string, _action: 'join' | 'leave', _componentId: string): Promise<void> {
    // No-op: membership is already tracked locally
  }

  async publishStateChange(_roomId: string, _updates: any): Promise<void> {
    // No-op: state changes are already propagated locally
  }
}
