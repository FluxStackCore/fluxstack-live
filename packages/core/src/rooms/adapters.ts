// @fluxstack/live - Room Adapter Interfaces
//
// Pluggable interfaces for room storage and cross-instance pub/sub.
// Default: InMemoryRoomAdapter (single-instance, no external dependencies).
// Optional: RedisRoomAdapter via @fluxstack/live-redis (horizontal scaling).

/**
 * Adapter for room state storage.
 *
 * All methods return Promises to support async backends (Redis, DB, etc.).
 * The InMemoryRoomAdapter resolves immediately for zero-overhead in single-instance mode.
 */
export interface IRoomStorageAdapter {
  /** Create or get a room. Returns current state and whether it was newly created. */
  getOrCreateRoom(roomId: string, initialState?: any): Promise<{ state: any; created: boolean }>

  /** Get the state of a room. Returns empty object if room doesn't exist. */
  getState(roomId: string): Promise<any>

  /** Update room state (merge partial updates). */
  updateState(roomId: string, updates: any): Promise<void>

  /** Check if a room exists. */
  hasRoom(roomId: string): Promise<boolean>

  /** Delete a room. Returns true if the room existed. */
  deleteRoom(roomId: string): Promise<boolean>

  /** Get storage statistics. */
  getStats(): Promise<{ totalRooms: number; rooms: Record<string, any> }>
}

/**
 * Adapter for cross-instance pub/sub (horizontal scaling).
 *
 * When running multiple server instances, this adapter propagates room events
 * between instances. In single-instance mode (InMemoryRoomAdapter), all pub/sub
 * operations are no-ops since events are already local.
 */
export interface IRoomPubSubAdapter {
  /** Publish an event to all server instances subscribed to this room. */
  publish(roomId: string, event: string, data: any): Promise<void>

  /** Subscribe to events for a room (from other server instances). */
  subscribe(roomId: string, handler: (event: string, data: any) => void): Promise<() => void>

  /** Publish a membership change (join/leave) to other instances. */
  publishMembership(roomId: string, action: 'join' | 'leave', componentId: string): Promise<void>

  /** Publish a state change to other instances. */
  publishStateChange(roomId: string, updates: any): Promise<void>
}
