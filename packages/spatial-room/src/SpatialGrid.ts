// SpatialGrid — uniform 2D/3D cell index for proximity queries.
//
// Each member occupies exactly one cell at any moment. Lookups by position
// return the union of all members in the surrounding `range` cells
// (3x3 for range=1 in 2D, 27 for range=1 in 3D, 5x5/125 for range=2, etc.).
//
// Cell key is a compact string ("x:y" or "x:y:z"). Maps are kept symmetric
// (member→cell + cell→members) so moves and removes are O(1).
//
// This module is pure data structure — no LiveRoom/WS coupling. SpatialLiveRoom
// composes it. Designed for hot-path use: getters allocate as little as
// possible and never traverse cells outside the query range.

export type Vec2 = readonly [number, number]
export type Vec3 = readonly [number, number, number]
export type Position = Vec2 | Vec3

export interface SpatialGridOptions {
  /** 2 (Vec2) or 3 (Vec3). Default: 2. */
  dimensions?: 2 | 3
  /** World-space size of one cell along each axis. Default: 100. */
  cellSize?: number
  /**
   * Default radius (in cells) returned by neighborCells/queryNear when the
   * caller doesn't pass one. 1 → 3×3 (2D) / 3×3×3 (3D). Default: 1.
   */
  defaultRange?: number
}

export class SpatialGrid<M = string> {
  readonly dimensions: 2 | 3
  readonly cellSize: number
  readonly defaultRange: number

  /** cellKey → Set of members in that cell */
  private cells = new Map<string, Set<M>>()
  /** member → current cellKey (so a move can leave the old cell in O(1)) */
  private memberCell = new Map<M, string>()

  constructor(options: SpatialGridOptions = {}) {
    this.dimensions = options.dimensions ?? 2
    this.cellSize = options.cellSize ?? 100
    this.defaultRange = options.defaultRange ?? 1
    if (this.cellSize <= 0 || !Number.isFinite(this.cellSize)) {
      throw new Error('SpatialGrid: cellSize must be a positive finite number')
    }
    if (this.defaultRange < 0 || !Number.isInteger(this.defaultRange)) {
      throw new Error('SpatialGrid: defaultRange must be a non-negative integer')
    }
  }

  /** Convert world position to integer cell coords. */
  private toCellCoords(pos: Position): number[] {
    const out = new Array(this.dimensions)
    for (let i = 0; i < this.dimensions; i++) {
      out[i] = Math.floor(pos[i]! / this.cellSize)
    }
    return out
  }

  private cellKey(coords: number[]): string {
    return this.dimensions === 2
      ? `${coords[0]}:${coords[1]}`
      : `${coords[0]}:${coords[1]}:${coords[2]}`
  }

  /** Direct world-position → cellKey shortcut. */
  positionToCellKey(pos: Position): string {
    return this.cellKey(this.toCellCoords(pos))
  }

  /**
   * Place or move a member to the given position. O(1) — removes from old
   * cell (if any) and adds to the new one. Returns true if the member
   * crossed a cell boundary (i.e. its visible neighborhood may have changed).
   */
  setPosition(member: M, pos: Position): boolean {
    const newKey = this.positionToCellKey(pos)
    const oldKey = this.memberCell.get(member)
    if (oldKey === newKey) return false

    if (oldKey !== undefined) {
      const oldCell = this.cells.get(oldKey)
      if (oldCell) {
        oldCell.delete(member)
        if (oldCell.size === 0) this.cells.delete(oldKey)
      }
    }

    let cell = this.cells.get(newKey)
    if (!cell) {
      cell = new Set()
      this.cells.set(newKey, cell)
    }
    cell.add(member)
    this.memberCell.set(member, newKey)
    return true
  }

  /** Remove a member entirely. O(1). No-op if the member isn't tracked. */
  remove(member: M): void {
    const key = this.memberCell.get(member)
    if (key === undefined) return
    this.memberCell.delete(member)
    const cell = this.cells.get(key)
    if (cell) {
      cell.delete(member)
      if (cell.size === 0) this.cells.delete(key)
    }
  }

  /** Current cellKey of a member, or undefined if not tracked. */
  getCell(member: M): string | undefined {
    return this.memberCell.get(member)
  }

  /** Whether a member has a known position. */
  has(member: M): boolean {
    return this.memberCell.has(member)
  }

  /** Total tracked members. */
  get size(): number {
    return this.memberCell.size
  }

  /**
   * Yield every cell key within `range` cells of `pos` (inclusive).
   * range=0 yields just the cell containing pos. range=1 yields a 3×3 (2D)
   * or 3×3×3 (3D) cube. Caller iterates lazily — no array materialised.
   */
  *neighborCells(pos: Position, range: number = this.defaultRange): Generator<string> {
    const c = this.toCellCoords(pos)
    if (this.dimensions === 2) {
      for (let dx = -range; dx <= range; dx++) {
        for (let dy = -range; dy <= range; dy++) {
          yield `${c[0]! + dx}:${c[1]! + dy}`
        }
      }
    } else {
      for (let dx = -range; dx <= range; dx++) {
        for (let dy = -range; dy <= range; dy++) {
          for (let dz = -range; dz <= range; dz++) {
            yield `${c[0]! + dx}:${c[1]! + dy}:${c[2]! + dz}`
          }
        }
      }
    }
  }

  /**
   * Collect all members within `range` cells of `pos`. Useful for broadcast:
   * the caller iterates the returned Set once. We collect into a Set (not
   * an array) to deduplicate when callers pass a position that maps to a
   * cell that overlaps with the sender's own — they normally want to send
   * to "everyone visible", with the sender filtering itself separately.
   */
  queryNear(pos: Position, range: number = this.defaultRange): Set<M> {
    const result = new Set<M>()
    for (const key of this.neighborCells(pos, range)) {
      const cell = this.cells.get(key)
      if (cell) for (const m of cell) result.add(m)
    }
    return result
  }

  /**
   * Collect all members within `range` cells of `member`'s current position.
   * Convenience wrapper for the common pattern "broadcast to peers near me".
   * If `excludeSelf` is true (default), the member itself is removed from
   * the result.
   */
  queryNearMember(member: M, range: number = this.defaultRange, excludeSelf = true): Set<M> {
    const myKey = this.memberCell.get(member)
    if (myKey === undefined) return new Set()
    const result = new Set<M>()
    // Reconstruct position from cellKey — avoids storing positions if the
    // caller doesn't keep them around. We just need the cell coords.
    const coords = myKey.split(':').map(Number)
    if (this.dimensions === 2) {
      for (let dx = -range; dx <= range; dx++) {
        for (let dy = -range; dy <= range; dy++) {
          const cell = this.cells.get(`${coords[0]! + dx}:${coords[1]! + dy}`)
          if (cell) for (const m of cell) result.add(m)
        }
      }
    } else {
      for (let dx = -range; dx <= range; dx++) {
        for (let dy = -range; dy <= range; dy++) {
          for (let dz = -range; dz <= range; dz++) {
            const cell = this.cells.get(`${coords[0]! + dx}:${coords[1]! + dy}:${coords[2]! + dz}`)
            if (cell) for (const m of cell) result.add(m)
          }
        }
      }
    }
    if (excludeSelf) result.delete(member)
    return result
  }

  /** Number of populated cells. Useful for diagnostics. */
  get cellCount(): number {
    return this.cells.size
  }

  /** Reset all state. */
  clear(): void {
    this.cells.clear()
    this.memberCell.clear()
  }
}
