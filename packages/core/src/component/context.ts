// @fluxstack/live - Dependency Injection via Module-Level Setter
//
// The public API of LiveComponent does NOT change.
// Internally, singletons (roomEvents, roomManager, etc.) are injected once at boot
// via setLiveComponentContext(), called by LiveServer.start().

import type { RoomEventBus } from '../rooms/RoomEventBus'

// ===== Room Manager Interface =====
// Extracted to avoid circular dependency with LiveRoomManager

export interface LiveRoomManagerInterface {
  joinRoom<TState = any>(componentId: string, roomId: string, ws: any, initialState?: TState, options?: { deepDiff?: boolean; deepDiffDepth?: number; serverOnlyState?: boolean }, joinContext?: { userId?: string; payload?: any }): Promise<{ state: TState; rejected?: false } | { rejected: true; reason: string }>
  leaveRoom(componentId: string, roomId: string, leaveReason?: 'leave' | 'disconnect' | 'cleanup'): void | Promise<void>
  cleanupComponent(componentId: string): void | Promise<void>
  emitToRoom(roomId: string, event: string, data: any, excludeComponentId?: string): number
  setRoomState(roomId: string, updates: any, excludeComponentId?: string): void
  getRoomState<TState = any>(roomId: string): TState
  isInRoom(componentId: string, roomId: string): boolean
  getComponentRooms(componentId: string): string[]
  getMemberCount?(roomId: string): number
  getRoomInstance?(roomId: string): import('../rooms/LiveRoom').LiveRoom<any, any, any> | undefined
  getStats(): any
}

// ===== Logger Interface =====

export interface LiveLoggerInterface {
  log(category: string, componentId: string | null, message: string, ...args: unknown[]): void
  warn(category: string, componentId: string | null, message: string, ...args: unknown[]): void
}

// ===== Context =====

export interface LiveComponentContext {
  roomEvents: RoomEventBus
  roomManager: LiveRoomManagerInterface
  /** Custom ID generator. When set, used instead of default crypto.randomUUID(). */
  generateId?: () => string
}

let _ctx: LiveComponentContext | null = null

/**
 * Set the global Live Component context.
 * Called once by LiveServer.start() before any components are mounted.
 */
export function setLiveComponentContext(ctx: LiveComponentContext): void {
  _ctx = ctx
}

/**
 * Get the global Live Component context.
 * Throws if LiveServer.start() hasn't been called yet.
 */
export function getLiveComponentContext(): LiveComponentContext {
  if (!_ctx) throw new Error('@fluxstack/live: LiveServer.start() must be called before using LiveComponents')
  return _ctx
}

/**
 * Check if context has been initialized (for internal use).
 */
export function hasLiveComponentContext(): boolean {
  return _ctx !== null
}
