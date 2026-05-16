// SpatialLiveRoom — LiveRoom with a per-room spatial grid for interest
// management. Members declare a position via setMemberPosition(); broadcasts
// done via emitNearby() reach only members in the surrounding cells instead
// of every member in the room.
//
// Drop-in: extend SpatialLiveRoom instead of LiveRoom. The existing emit() /
// setState() / onJoin() / etc. work unchanged. Spatial filtering is opt-in
// per emit (you pick which events go through the filter; chat-style global
// events keep using emit()).

import { LiveRoom, type RoomLeaveContext } from '@fluxstack/live'
import type { LiveRoomManager } from '@fluxstack/live'
import { SpatialGrid, type Position, type SpatialGridOptions } from './SpatialGrid'

export interface SpatialRoomConfig extends SpatialGridOptions {}

/**
 * Internal interface for the bits of LiveRoomManager we touch. The full
 * manager is much bigger; we only need the per-member emit added in core.
 */
interface ManagerWithMembers {
  emitToRoomMembers(
    roomId: string,
    members: Iterable<string>,
    event: string,
    data: any,
  ): number
}

export abstract class SpatialLiveRoom<
  TState extends Record<string, any> = Record<string, any>,
  TMeta extends Record<string, any> = Record<string, any>,
  TEvents extends Record<string, any> = Record<string, any>,
> extends LiveRoom<TState, TMeta, TEvents> {
  /**
   * Spatial configuration. Subclasses override with their own grid sizing.
   * Defaults: 2D, 100-unit cells, range=1 (3×3 neighborhood).
   */
  static spatial: SpatialRoomConfig = {}

  /** Per-instance grid. Initialised lazily on first position write. */
  private _grid: SpatialGrid<string> | null = null

  /** Lazy grid getter so unused features cost nothing. */
  public get grid(): SpatialGrid<string> {
    if (!this._grid) {
      const ctor = this.constructor as typeof SpatialLiveRoom
      this._grid = new SpatialGrid<string>(ctor.spatial ?? {})
    }
    return this._grid
  }

  /**
   * Place or move a member in the grid. Call this whenever a player's
   * position changes (typically inside an action handler).
   *
   * Idempotent — calling with the same cell as before is a no-op.
   *
   * @returns true if the member crossed a cell boundary (useful if you
   *          want to notify the moving player about new visible peers).
   */
  public setMemberPosition(componentId: string, pos: Position): boolean {
    return this.grid.setPosition(componentId, pos)
  }

  /**
   * Get the current cell key of a member, or undefined if no position
   * has been set for them. Useful for diagnostics.
   */
  public getMemberCell(componentId: string): string | undefined {
    return this._grid?.getCell(componentId)
  }

  /**
   * Broadcast an event to members near the sender. The sender itself is
   * excluded by default (matches the LiveRoom.emit convention).
   *
   * If the sender has no recorded position, falls back to a global emit
   * (so an early call before setMemberPosition still works).
   *
   * @returns number of members notified
   */
  emitNearby<K extends keyof TEvents & string>(
    senderComponentId: string,
    event: K,
    data: TEvents[K],
    options?: { range?: number; includeSelf?: boolean },
  ): number {
    const range = options?.range ?? this.grid.defaultRange
    const includeSelf = options?.includeSelf ?? false
    const grid = this._grid
    if (!grid || !grid.has(senderComponentId)) {
      // No position recorded — fall back to global broadcast so the caller
      // still sees the event delivered. excludeSelf default matches emit().
      return this.emit(event, data)
    }
    const targets = grid.queryNearMember(senderComponentId, range, !includeSelf)
    return (this._manager as unknown as ManagerWithMembers)
      .emitToRoomMembers(this.id, targets, event, data)
  }

  /**
   * Broadcast an event to members near an arbitrary world position
   * (independent of any sender). Useful for "explosion at (x,y)" events
   * that originate from the server, not a player.
   *
   * @returns number of members notified
   */
  emitAtPosition<K extends keyof TEvents & string>(
    pos: Position,
    event: K,
    data: TEvents[K],
    options?: { range?: number },
  ): number {
    const range = options?.range ?? this.grid.defaultRange
    const targets = this.grid.queryNear(pos, range)
    return (this._manager as unknown as ManagerWithMembers)
      .emitToRoomMembers(this.id, targets, event, data)
  }

  /**
   * Hook into LiveRoom's onLeave to automatically remove the member from
   * the spatial grid. Subclasses that override onLeave must call super.
   */
  override onLeave(ctx: RoomLeaveContext): void | Promise<void> {
    this._grid?.remove(ctx.componentId)
  }

  /**
   * Diagnostics: members currently visible from a given sender.
   * Exposed so dev tooling/tests can inspect the interest set.
   */
  getVisibleMembers(senderComponentId: string, range?: number): Set<string> {
    if (!this._grid) return new Set()
    return this._grid.queryNearMember(
      senderComponentId,
      range ?? this._grid.defaultRange,
      true,
    )
  }

  /**
   * Diagnostics: total cells currently occupied (sparse — empty cells are
   * not stored). Use to pick a sensible cellSize: if cellCount stays in
   * the single digits while you have hundreds of players, cells are too
   * big and the filter does little; if it explodes to thousands with few
   * players, cells are too small and lookups walk many empties.
   */
  getOccupiedCellCount(): number {
    return this._grid?.cellCount ?? 0
  }
}
