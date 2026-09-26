// @fluxstack/live - In-Memory Room Adapter (Default)
//
// Single-instance, zero-dependency adapter for room storage and pub/sub.
// All operations resolve synchronously via Promise.resolve().
// Pub/sub methods are no-ops since all events are already local.

import type { IRoomStorageAdapter, IRoomPubSubAdapter, RoomStorageStats } from './adapters'

interface RoomData {
  state: Record<string, unknown>
  createdAt: number
  lastUpdate: number
}

export class InMemoryRoomAdapter implements IRoomStorageAdapter, IRoomPubSubAdapter {
  private rooms = new Map<string, RoomData>()

  // ===== IRoomStorageAdapter =====

  async getOrCreateRoom(roomId: string, initialState?: Record<string, unknown>): Promise<{ state: Record<string, unknown>; created: boolean }> {
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

  async getState(roomId: string): Promise<Record<string, unknown>> {
    return this.rooms.get(roomId)?.state ?? {}
  }

  async updateState(roomId: string, updates: Record<string, unknown>): Promise<void> {
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

  async getStats(): Promise<{ totalRooms: number; rooms: Record<string, RoomStorageStats> }> {
    const rooms: Record<string, RoomStorageStats> = {}
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

  async publish(_roomId: string, _event: string, _data: unknown): Promise<void> {
    // No-op: events are already local
  }

  async subscribe(_roomId: string, _handler: (event: string, data: unknown) => void): Promise<() => void> {
    // No-op: return empty unsubscribe
    return () => {}
  }

  async publishMembership(_roomId: string, _action: 'join' | 'leave', _componentId: string): Promise<void> {
    // No-op: membership is already tracked locally
  }

  async publishStateChange(_roomId: string, _updates: unknown): Promise<void> {
    // No-op: state changes are already propagated locally
  }
}
