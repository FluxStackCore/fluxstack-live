// ChunkRoom — 3D block-grid LiveRoom for voxel/Minecraft-style worlds.
//
// Specialisation of SpatialLiveRoom with:
//   - Default 3D + cellSize = 16 (standard Minecraft chunk size).
//   - Helpers that work in chunk coordinates ([cx, cy, cz]) as well as
//     world coordinates: many voxel games naturally store player chunk
//     positions, not world positions.
//   - emitInChunk / emitNearChunks for the common "broadcast within chunk
//     load distance" pattern.

import { SpatialLiveRoom, type SpatialRoomConfig } from './SpatialLiveRoom'
import type { Vec3 } from './SpatialGrid'

export interface ChunkCoord extends Vec3 {}

/**
 * Convert chunk coordinates to a world-space position at the chunk's
 * origin. Useful when calling APIs that take world positions.
 */
export function chunkToWorld(coord: ChunkCoord, chunkSize: number): Vec3 {
  return [coord[0] * chunkSize, coord[1] * chunkSize, coord[2] * chunkSize]
}

/**
 * Convert a world-space position to its containing chunk coordinate.
 */
export function worldToChunk(pos: Vec3, chunkSize: number): Vec3 {
  return [Math.floor(pos[0] / chunkSize), Math.floor(pos[1] / chunkSize), Math.floor(pos[2] / chunkSize)]
}

export abstract class ChunkRoom<
  TState extends Record<string, any> = Record<string, any>,
  TMeta extends Record<string, any> = Record<string, any>,
  TEvents extends Record<string, any> = Record<string, any>,
> extends SpatialLiveRoom<TState, TMeta, TEvents> {
  /**
   * Default chunk config. Subclasses can override `spatial` to change
   * chunk size or view distance.
   *
   * chunkSize=16 matches Minecraft's standard chunk; view distance of 1
   * cell on each side = 3×3×3 = 27 chunks visible (the sender's chunk
   * + 26 neighbours), which is roughly Minecraft's "view-distance: 2"
   * setting in terms of chunks reached.
   */
  static spatial: SpatialRoomConfig = {
    dimensions: 3,
    cellSize: 16,
    defaultRange: 1,
  }

  /** Convenience: place a player by world position. Same as setMemberPosition. */
  setMemberWorldPosition(componentId: string, x: number, y: number, z: number): boolean {
    return this.setMemberPosition(componentId, [x, y, z])
  }

  /** Place a player by chunk coordinate (and offset 0 inside the chunk). */
  setMemberChunk(componentId: string, chunk: ChunkCoord): boolean {
    const ctor = this.constructor as typeof ChunkRoom
    const size = ctor.spatial.cellSize ?? 16
    return this.setMemberPosition(componentId, chunkToWorld(chunk, size))
  }

  /** The chunk coord this player currently occupies, or undefined. */
  getMemberChunk(componentId: string): ChunkCoord | undefined {
    const key = this.getMemberCell(componentId)
    if (!key) return undefined
    const parts = key.split(':').map(Number)
    if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return undefined
    return [parts[0]!, parts[1]!, parts[2]!]
  }

  /**
   * Broadcast an event only to players in the same chunk + the neighbouring
   * chunks (3×3×3 cube by default). The sender is excluded by default.
   * If the sender has no recorded chunk, falls back to a global emit.
   */
  emitInChunkRange<K extends keyof TEvents & string>(
    senderComponentId: string,
    event: K,
    data: TEvents[K],
    options?: { range?: number; includeSelf?: boolean },
  ): number {
    // Same semantics as emitNearby — provided under a more game-y name.
    return this.emitNearby(senderComponentId, event, data, options)
  }

  /**
   * Broadcast an event to all players in a specific chunk neighbourhood
   * (no sender — pure world-event like "block placed at chunk X").
   */
  emitAtChunk<K extends keyof TEvents & string>(
    chunk: ChunkCoord,
    event: K,
    data: TEvents[K],
    options?: { range?: number },
  ): number {
    const ctor = this.constructor as typeof ChunkRoom
    const size = ctor.spatial.cellSize ?? 16
    // Use chunk centre for the query so range=1 picks up the chunk itself
    // plus its 26 neighbours, regardless of which corner the player is in.
    const centre: Vec3 = [
      chunk[0] * size + size / 2,
      chunk[1] * size + size / 2,
      chunk[2] * size + size / 2,
    ]
    return this.emitAtPosition(centre, event, data, options)
  }
}
