// @fluxstack/live - Dependency Injection via Module-Level Setter
//
// The public API of LiveComponent does NOT change.
// Internally, singletons (roomEvents, roomManager, etc.) are injected once at boot
// via setLiveComponentContext(), called by LiveServer.start().

import type { RoomEventBus } from '../rooms/RoomEventBus'
import type { LiveDebugger } from '../debug/LiveDebugger'

// ===== Room Manager Interface =====
// Extracted to avoid circular dependency with LiveRoomManager

export interface LiveRoomManagerInterface {
  joinRoom<TState = any>(componentId: string, roomId: string, ws: any, initialState?: TState): { state: TState }
  leaveRoom(componentId: string, roomId: string): void
  cleanupComponent(componentId: string): void
  emitToRoom(roomId: string, event: string, data: any, excludeComponentId?: string): number
  setRoomState(roomId: string, updates: any, excludeComponentId?: string): void
  getRoomState<TState = any>(roomId: string): TState
  isInRoom(componentId: string, roomId: string): boolean
  getComponentRooms(componentId: string): string[]
  getStats(): any
}

// ===== Debugger Interface =====

export interface LiveDebuggerInterface {
  enabled: boolean
  trackStateChange(componentId: string, delta: Record<string, unknown>, fullState: Record<string, unknown>, source?: string): void
  trackActionCall(componentId: string, action: string, payload: unknown): void
  trackActionResult(componentId: string, action: string, result: unknown, duration: number): void
  trackActionError(componentId: string, action: string, error: string, duration: number): void
  trackRoomEmit(componentId: string, roomId: string, event: string, data: unknown): void
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
  debugger?: LiveDebuggerInterface
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
