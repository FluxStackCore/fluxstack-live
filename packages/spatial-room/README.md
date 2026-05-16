# @fluxstack/spatial-room

Interest management for `@fluxstack/live` rooms. Reduces broadcast cost from
**O(N)** to **O(visible cells)** for games where players only need updates
from nearby peers.

Two ready-to-use room classes:

- **`SpatialLiveRoom`** — general 2D/3D grid. Top-down RPG, side-scroller,
  `.io` games, MMO maps.
- **`ChunkRoom`** — specialised 3D voxel/Minecraft-style chunks. Default
  `cellSize=16` (Minecraft standard chunk), default view distance 1
  (3×3×3 = 27 chunks visible).

## Why

A LiveRoom with 1000 members fanouts every `emit()` to **all 1000** WebSocket
connections. For chat/state updates that's fine; for player movement at
30/60 Hz it crushes the server. Spatial rooms keep an internal grid and only
deliver to members in the surrounding cells of the sender.

Measured impact (see tests):

- **2D, 1000 players in 1000×1000 world, cellSize=100**: broadcast reaches
  **86 peers (8.6% of room)** instead of 999 (91% reduction).
- **3D voxel, 1000 players in 30³ chunks, view distance 1**: broadcast reaches
  **33 peers (3.3% of room)** instead of 999 (97% reduction).

## Install

```bash
bun add @fluxstack/spatial-room
```

## Quick start — 2D top-down

```ts
import { SpatialLiveRoom } from '@fluxstack/spatial-room'

interface GameState {
  players: Record<string, { x: number; y: number; hp: number }>
}

interface GameEvents {
  moved: { id: string; x: number; y: number }
  shot:  { from: string; angle: number }
}

class GameRoom extends SpatialLiveRoom<GameState, any, GameEvents> {
  static roomName = 'game'
  static defaultState: GameState = { players: {} }
  static spatial = {
    dimensions: 2,
    cellSize: 100,      // world units per cell
    defaultRange: 1,    // 3×3 visible neighbourhood
  }

  movePlayer(componentId: string, x: number, y: number) {
    this.setMemberPosition(componentId, [x, y])
    this.state.players[componentId] = { ...this.state.players[componentId]!, x, y }
    // Only players in the same or adjacent cells receive this:
    this.emitNearby(componentId, 'moved', { id: componentId, x, y })
  }
}
```

## Quick start — 3D voxel / Minecraft

```ts
import { ChunkRoom } from '@fluxstack/spatial-room'

class WorldRoom extends ChunkRoom<{}, any, {
  blockPlaced: { x: number; y: number; z: number; type: number }
}> {
  static roomName = 'world'
  static defaultState = {}
  // Defaults: 3D, cellSize=16, range=1 → 27 chunks visible. Override
  // `static spatial = { cellSize: ..., defaultRange: ... }` if needed.

  placeBlock(componentId: string, x: number, y: number, z: number, type: number) {
    this.setMemberWorldPosition(componentId, x, y, z) // updates the grid
    // Only players in nearby chunks receive this:
    this.emitInChunkRange(componentId, 'blockPlaced', { x, y, z, type })
  }
}
```

## API

### `SpatialLiveRoom` (extends `LiveRoom`)

| method | description |
|---|---|
| `setMemberPosition(id, [x, y]` or `[x, y, z])` | place / move a member in the grid. Idempotent; returns `true` if the member crossed a cell boundary. |
| `getMemberCell(id)` | current cell key (string), or `undefined` |
| `emitNearby(senderId, event, data, opts?)` | broadcast only to members within `opts.range` cells of the sender (default `defaultRange`). Sender excluded unless `includeSelf`. Falls back to global `emit()` if sender has no recorded position. |
| `emitAtPosition([x, y], event, data, opts?)` | broadcast to members near an arbitrary world point (no sender — useful for "explosion at X") |
| `getVisibleMembers(id, range?)` | diagnostic: who can see this member |
| `getOccupiedCellCount()` | diagnostic: populated cells — useful to tune `cellSize` |

The `grid` property exposes the underlying `SpatialGrid` for advanced
use (custom queries, manual indexing).

### `ChunkRoom` (extends `SpatialLiveRoom` with 3D defaults)

Adds:

| method | description |
|---|---|
| `setMemberWorldPosition(id, x, y, z)` | same as `setMemberPosition` but with explicit args |
| `setMemberChunk(id, [cx, cy, cz])` | place a member by chunk coord (places at chunk origin) |
| `getMemberChunk(id)` | current chunk coord `[cx, cy, cz]` or `undefined` |
| `emitInChunkRange(senderId, event, data, opts?)` | alias of `emitNearby` with game-y naming |
| `emitAtChunk([cx, cy, cz], event, data, opts?)` | broadcast to members near a chunk (server-originated events) |

Plus the helper functions:

- `chunkToWorld([cx, cy, cz], chunkSize)` → world `[x, y, z]` at chunk origin
- `worldToChunk([x, y, z], chunkSize)` → containing chunk `[cx, cy, cz]`

### `SpatialGrid<M>` (low-level)

If you want spatial indexing **without** the LiveRoom integration (e.g. for
bots / NPCs / server-side AI):

```ts
import { SpatialGrid } from '@fluxstack/spatial-room'

const grid = new SpatialGrid<string>({ dimensions: 2, cellSize: 50 })
grid.setPosition('npc-1', [120, 80])
grid.setPosition('npc-2', [125, 85])
grid.queryNear([100, 100], 1)  // → Set { 'npc-1', 'npc-2' }
grid.queryNearMember('npc-1')  // → Set { 'npc-2' } (excludes self)
```

## Tuning `cellSize`

Rule of thumb: pick `cellSize` so that one cell contains the **interaction
range** of a player. For a top-down shooter with bullets visible up to 500
units away, `cellSize=500` and `range=1` (3×3 = 1500 units of coverage) is
a good start.

Diagnostic: if `room.getOccupiedCellCount()` stays in single digits with
hundreds of players, cells are **too big** (everyone in the same cell —
filter does nothing). If it explodes to thousands with few players, cells
are **too small** (lookups walk many empty cells).

## What it does NOT do

- **State broadcast**: `setState` still goes to all members. Interest
  management here is for **events** (`emit`), not the shared room state.
  Most games keep state as "world data" (replicated everywhere) and use
  events for per-player updates anyway.
- **Custom shapes**: only axis-aligned cells. No circles, no view cones,
  no occlusion. Build those on top by combining `queryNear` results with
  your own filters.
- **Dynamic load balancing**: cells are uniform. If you have a dense club
  next to an empty desert, the club's cell will be a hotspot. For that
  case, look at quadtree / R-tree libraries — this package intentionally
  stays simple.
