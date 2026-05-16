// @fluxstack/live - LiveRoom Base Class
//
// Typed room classes with lifecycle hooks, public/private state split,
// and server-only join enforcement.
//
// Usage:
//   class ChatRoom extends LiveRoom<ChatState, ChatMeta, ChatEvents> {
//     static roomName = 'chat'
//     static defaultState = { messages: [] }
//     static defaultMeta = { password: null }
//     onJoin(ctx) { ... }
//   }

import type { LiveRoomManagerInterface } from '../component/context'
import type { RoomCodecOption } from './RoomCodec'
import type { LiveAuthSession } from '../auth/types'

// ===== Lifecycle Context Types =====

export interface RoomJoinContext<TMembership = any> {
  componentId: string
  /**
   * Full auth session of the joining peer (when authenticated). Generic by
   * design — only `id` is fixed; any field on `LiveAuthSession` can be a
   * user, bot, device, service, etc. depending on the auth provider.
   * Frozen — do not mutate; use `membership` for per-member state.
   */
  session?: LiveAuthSession
  /** @deprecated Use `session?.id`. Kept for backwards compatibility. */
  userId?: string
  payload?: any
  /**
   * Per-member, server-only metadata bag. Mutate freely from `onJoin`
   * (e.g. `ctx.membership.playerId = payload.playerId`); the same object
   * is handed back to `onLeave` so domain code can clean up state keyed
   * by app-specific identifiers (#36).
   *
   * Lives only inside the room — never sent to clients.
   */
  membership: TMembership
}

export interface RoomLeaveContext<TMembership = any> {
  componentId: string
  /**
   * Full auth session captured at join time. See `RoomJoinContext.session`.
   */
  session?: LiveAuthSession
  /** @deprecated Use `session?.id`. Kept for backwards compatibility. */
  userId?: string
  reason: 'leave' | 'disconnect' | 'cleanup'
  /**
   * The membership bag populated during `onJoin`. Use this to find and
   * remove entries from `room.state` that are keyed by an app-specific id
   * rather than the framework's `componentId` (#36).
   *
   * Always defined (defaults to an empty object) so consumers can read
   * fields without nil-checking the whole object.
   */
  membership: TMembership
}

export interface RoomEventContext {
  componentId: string
  /** Full auth session of the emitter, when authenticated. */
  session?: LiveAuthSession
  /** @deprecated Use `session?.id`. Kept for backwards compatibility. */
  userId?: string
}

// ===== Room Options =====

export interface LiveRoomOptions {
  /** Enable deep diff for room state. Default: true */
  deepDiff?: boolean
  /** Max recursion depth for deep diff. Default: 3 */
  deepDiffDepth?: number
  /** Max number of members allowed. Undefined = unlimited */
  maxMembers?: number
  /**
   * Wire codec for room messages. Default: 'msgpack' (binary).
   * - 'msgpack' — Built-in MessagePack encoder (zero deps, ~30% smaller, ~2-3x faster)
   * - 'json' — Standard JSON (text-based, larger but human-readable)
   * - Custom RoomCodec object with encode/decode methods
   */
  codec?: RoomCodecOption
}

// ===== LiveRoom Base Class =====

/**
 * Base class for typed rooms with lifecycle hooks and public/private state.
 *
 * @typeParam TState - Public state synced to all connected clients
 * @typeParam TMeta - Private server-only metadata (never broadcasted)
 * @typeParam TEvents - Event map for typed emit/on
 */
export abstract class LiveRoom<
  TState extends Record<string, any> = Record<string, any>,
  TMeta extends Record<string, any> = Record<string, any>,
  TEvents extends Record<string, any> = Record<string, any>,
> {
  /** Unique room type name. Used as prefix in compound room IDs (e.g. "chat:lobby"). */
  static roomName: string

  /** Initial public state template. Cloned per room instance. */
  static defaultState: Record<string, any> = {}

  /** Initial private metadata template. Cloned per room instance. */
  static defaultMeta: Record<string, any> = {}

  /** Room-level options */
  static $options?: LiveRoomOptions

  /** The unique room instance identifier (e.g. "chat:lobby") */
  readonly id: string

  /** Public state — synced to all connected clients via setState(). */
  state: TState

  /** Private metadata — NEVER leaves the server. Mutate directly. */
  meta: TMeta

  /** @internal Type brand for client-side event inference.
   * No runtime value. Usage: `$room<CounterRoom>('id').on(...)` */
  declare readonly $events: TEvents

  /** @internal Reference to the room manager for broadcasting */
  protected readonly _manager: LiveRoomManagerInterface

  constructor(id: string, manager: LiveRoomManagerInterface) {
    const ctor = this.constructor as typeof LiveRoom
    this.id = id
    this._manager = manager
    this.state = structuredClone(ctor.defaultState ?? {}) as TState
    this.meta = structuredClone(ctor.defaultMeta ?? {}) as TMeta
  }

  // ===== Framework Methods =====

  /**
   * Update public state and broadcast changes to all room members.
   * Uses deep diff by default — only changed fields are sent over the wire.
   */
  setState(updates: Partial<TState>): void {
    this._manager.setRoomState(this.id, updates)
  }

  /**
   * Emit a typed event to all members in this room.
   * @returns Number of members notified
   */
  emit<K extends keyof TEvents & string>(event: K, data: TEvents[K]): number {
    return this._manager.emitToRoom(this.id, event, data)
  }

  /**
   * Update public state and emit an event atomically.
   *
   * Equivalent to calling `setState(updates)` followed by `emit(event, data)`,
   * but as a single explicit operation that makes the intent clear: "update
   * state AND notify clients". Eliminates the common two-call pattern and
   * prevents bugs where one of the two calls is accidentally omitted.
   *
   * Receivers can use the event payload directly without re-reading room state,
   * which avoids the shared-reference footgun described in issue #19.
   *
   * @returns Number of members notified
   */
  emitWithState<K extends keyof TEvents & string>(event: K, data: TEvents[K], updates: Partial<TState>): number {
    this._manager.setRoomState(this.id, updates)
    return this._manager.emitToRoom(this.id, event, data)
  }

  /** Get current member count */
  get memberCount(): number {
    return this._manager.getMemberCount?.(this.id) ?? 0
  }

  // ===== Lifecycle Hooks (override in subclass) =====

  /**
   * Called when a component attempts to join this room.
   * Return false to reject the join.
   */
  onJoin(_ctx: RoomJoinContext): void | false | Promise<void | false> {}

  /**
   * Called after a component leaves this room.
   */
  onLeave(_ctx: RoomLeaveContext): void | Promise<void> {}

  /**
   * Called when an event is emitted to this room.
   * Can intercept/validate events before broadcasting.
   */
  onEvent(_event: string, _data: any, _ctx: RoomEventContext): void | Promise<void> {}

  /**
   * Called once when the room is first created (first member joins).
   */
  onCreate(): void | Promise<void> {}

  /**
   * Called when the last member leaves and the room is about to be destroyed.
   * Return false to keep the room alive (e.g., persist state).
   */
  onDestroy(): void | false | Promise<void | false> {}
}

// ===== Type Utilities =====

/** Extract the public state type from a LiveRoom subclass */
export type InferRoomState<R> =
  R extends LiveRoom<infer S, any, any> ? S : Record<string, any>

/** Extract the private meta type from a LiveRoom subclass */
export type InferRoomMeta<R> =
  R extends LiveRoom<any, infer M, any> ? M : Record<string, any>

/** Extract the events type from a LiveRoom subclass */
export type InferRoomEvents<R> =
  R extends LiveRoom<any, any, infer E> ? E : Record<string, any>

/** LiveRoom class constructor type */
export type LiveRoomClass<R extends LiveRoom = LiveRoom> = {
  new (id: string, manager: LiveRoomManagerInterface): R
  roomName: string
  defaultState: Record<string, any>
  defaultMeta: Record<string, any>
  $options?: LiveRoomOptions
}
