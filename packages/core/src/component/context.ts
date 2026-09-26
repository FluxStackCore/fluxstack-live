// @fluxstack/live - Dependency Injection via Module-Level Setter
//
// The public API of LiveComponent does NOT change.
// Internally, singletons (roomEvents, roomManager, etc.) are injected once at boot
// via setLiveComponentContext(), called by LiveServer.start().

import type { RoomEventBus } from '../rooms/RoomEventBus'
import type { AnyLiveRoom } from '../rooms/LiveRoom'
import type { GenericWebSocket } from '../transport/types'
import type { LiveAuthSession } from '../auth/types'

// ===== Room Manager Interface =====
// Extracted to avoid circular dependency with LiveRoomManager

/** Opções de sala definidas por quem entra primeiro (salas legadas). */
export interface RoomJoinOptions {
  deepDiff?: boolean
  deepDiffDepth?: number
  serverOnlyState?: boolean
}

/** Contexto repassado ao `onJoin` de uma LiveRoom. */
export interface RoomJoinExtra {
  userId?: string
  session?: LiveAuthSession
  /** Payload de `$room(Classe, id).join(payload)` — a sala valida. */
  payload?: unknown
}

/** Resultado de `joinRoom`: state atual da sala ou recusa do `onJoin`. */
export type RoomJoinOutcome<TState> = { state: TState; rejected?: false } | { rejected: true; reason: string }

export interface LiveRoomManagerInterface {
  joinRoom<TState = Record<string, unknown>>(componentId: string, roomId: string, ws: GenericWebSocket, initialState?: TState, options?: RoomJoinOptions, joinContext?: RoomJoinExtra): Promise<RoomJoinOutcome<TState>>
  leaveRoom(componentId: string, roomId: string, leaveReason?: 'leave' | 'disconnect' | 'cleanup'): void | Promise<void>
  cleanupComponent(componentId: string): void | Promise<void>
  emitToRoom(roomId: string, event: string, data: unknown, excludeComponentId?: string): number
  /** Emit to a specific subset of room members. Used by interest-management plugins. */
  emitToRoomMembers?(roomId: string, members: Iterable<string>, event: string, data: unknown): number
  setRoomState(roomId: string, updates: object, excludeComponentId?: string): void
  /** O chamador escolhe TState (salas legadas não carregam tipo em runtime). */
  getRoomState<TState = Record<string, unknown>>(roomId: string): TState
  isInRoom(componentId: string, roomId: string): boolean
  getComponentRooms(componentId: string): string[]
  getMemberCount?(roomId: string): number
  getRoomInstance?(roomId: string): AnyLiveRoom | undefined
  getStats(): unknown
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
