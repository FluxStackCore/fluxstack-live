// ChunkRoom — voxel/Minecraft-style 3D chunked room.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LiveRoomManager, RoomRegistry, RoomEventBus } from '@fluxstack/live'
import { ChunkRoom, chunkToWorld, worldToChunk } from '../ChunkRoom'

type AnyWS = any

function mockWs(id: string) {
  const sent: any[] = []
  const data = {
    connectionId: id, components: new Map(), subscriptions: new Set(),
    connectedAt: new Date(), userId: undefined,
    authContext: { authenticated: false, session: undefined,
      hasRole: () => false, hasAnyRole: () => false, hasAllRoles: () => false,
      hasPermission: () => false, hasAllPermissions: () => false, hasAnyPermission: () => false } as any,
  }
  return {
    send: (m: any) => { sent.push(m) },
    close: () => {},
    data, remoteAddress: '127.0.0.1', readyState: 1 as const, _sent: sent,
  } as AnyWS
}

interface VoxelState { blocks: Record<string, number> }

class MinecraftRoom extends ChunkRoom<VoxelState, any, {
  blockPlaced: { x: number; y: number; z: number; type: number }
  chat: { from: string; text: string }
}> {
  static roomName = 'mc'
  static defaultState: VoxelState = { blocks: {} }
  // Override to override chunk size if needed; default is 16 (Minecraft standard).
}

class FineGrainedRoom extends ChunkRoom<{}, any, { tick: { n: number } }> {
  static roomName = 'fine'
  static defaultState = {}
  static spatial = { dimensions: 3 as const, cellSize: 8, defaultRange: 2 }
}

function makeManager() {
  const mgr = new LiveRoomManager(new RoomEventBus())
  const reg = new RoomRegistry()
  mgr.roomRegistry = reg
  return { mgr, reg }
}

let errSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => { errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { errSpy?.mockRestore() })

// ─────────────────────────────────────────────────────────────────────────
describe('chunkToWorld / worldToChunk helpers', () => {
  it('chunkToWorld returns chunk origin', () => {
    expect(chunkToWorld([0, 0, 0], 16)).toEqual([0, 0, 0])
    expect(chunkToWorld([1, 2, -1], 16)).toEqual([16, 32, -16])
  })

  it('worldToChunk floors to chunk coord', () => {
    expect(worldToChunk([0, 0, 0], 16)).toEqual([0, 0, 0])
    expect(worldToChunk([15.99, 0, 0], 16)).toEqual([0, 0, 0])
    expect(worldToChunk([16, 0, 0], 16)).toEqual([1, 0, 0])
    expect(worldToChunk([-1, 0, 0], 16)).toEqual([-1, 0, 0]) // floor(-0.0625)=-1
  })

  it('round-trip world → chunk → world lands at the chunk origin', () => {
    expect(chunkToWorld(worldToChunk([100, 200, 300], 16), 16)).toEqual([96, 192, 288])
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('ChunkRoom — defaults', () => {
  it('defaults to 3D, cellSize 16, range 1 (3×3×3 = 27 chunks visible)', () => {
    expect(ChunkRoom.spatial.dimensions).toBe(3)
    expect(ChunkRoom.spatial.cellSize).toBe(16)
    expect(ChunkRoom.spatial.defaultRange).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('ChunkRoom — member placement', () => {
  it('setMemberWorldPosition and setMemberChunk both place the player', async () => {
    const { mgr, reg } = makeManager()
    reg.register(MinecraftRoom as any)
    await mgr.joinRoom('alice', 'mc:r', mockWs('alice'))

    const room = (mgr as any).rooms.get('mc:r').instance as MinecraftRoom

    room.setMemberWorldPosition('alice', 0, 64, 0)
    expect(room.getMemberChunk('alice')).toEqual([0, 4, 0]) // y=64 / 16 = chunk 4

    room.setMemberChunk('alice', [3, 0, -2])
    expect(room.getMemberChunk('alice')).toEqual([3, 0, -2])
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('ChunkRoom — emitInChunkRange', () => {
  it('only delivers to players within chunk view distance', async () => {
    const { mgr, reg } = makeManager()
    reg.register(MinecraftRoom as any)
    const wsA = mockWs('A')
    const wsNeighbor = mockWs('Neighbor')
    const wsFar = mockWs('Far')
    await mgr.joinRoom('A', 'mc:r', wsA)
    await mgr.joinRoom('Neighbor', 'mc:r', wsNeighbor)
    await mgr.joinRoom('Far', 'mc:r', wsFar)

    const room = (mgr as any).rooms.get('mc:r').instance as MinecraftRoom
    room.setMemberChunk('A', [0, 0, 0])
    room.setMemberChunk('Neighbor', [1, 0, 0])    // adjacent chunk
    room.setMemberChunk('Far', [10, 10, 10])      // way out of range

    wsA._sent.length = 0
    wsNeighbor._sent.length = 0
    wsFar._sent.length = 0

    const sent = room.emitInChunkRange('A', 'blockPlaced', { x: 1, y: 65, z: 1, type: 1 })
    expect(sent).toBe(1) // only Neighbor
    expect(wsNeighbor._sent.length).toBe(1)
    expect(wsFar._sent.length).toBe(0)
  })

  it('view distance >1 reaches farther neighbours', async () => {
    const { mgr, reg } = makeManager()
    reg.register(MinecraftRoom as any)
    const wsList = ['A', 'B', 'C'].map(mockWs)
    for (const ws of wsList) await mgr.joinRoom(ws.data.connectionId, 'mc:r', ws)

    const room = (mgr as any).rooms.get('mc:r').instance as MinecraftRoom
    room.setMemberChunk('A', [0, 0, 0])
    room.setMemberChunk('B', [2, 0, 0])  // 2 chunks away — out of range 1
    room.setMemberChunk('C', [3, 0, 0])  // 3 chunks away

    for (const ws of wsList) ws._sent.length = 0

    // With range=2, B should be reached (2 cells), C should not (3 cells).
    const sent = room.emitInChunkRange('A', 'chat', { from: 'A', text: 'hi' }, { range: 2 })
    expect(sent).toBe(1)
    expect(wsList[1]!._sent.length).toBe(1) // B
    expect(wsList[2]!._sent.length).toBe(0) // C
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('ChunkRoom — emitAtChunk (no sender, "block placed at chunk X")', () => {
  it('reaches players near a given chunk', async () => {
    const { mgr, reg } = makeManager()
    reg.register(MinecraftRoom as any)
    const wsA = mockWs('A')
    const wsB = mockWs('B')
    await mgr.joinRoom('A', 'mc:r', wsA)
    await mgr.joinRoom('B', 'mc:r', wsB)

    const room = (mgr as any).rooms.get('mc:r').instance as MinecraftRoom
    room.setMemberChunk('A', [5, 0, 5])
    room.setMemberChunk('B', [100, 0, 100])

    wsA._sent.length = 0
    wsB._sent.length = 0

    // Server places a block at chunk [4, 0, 5] (adjacent to A).
    const sent = room.emitAtChunk([4, 0, 5], 'blockPlaced', { x: 70, y: 64, z: 80, type: 5 })
    expect(sent).toBe(1)
    expect(wsA._sent.length).toBe(1)
    expect(wsB._sent.length).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('ChunkRoom — fine-grained cellSize for high-density games', () => {
  it('smaller cellSize + bigger range still filters correctly', async () => {
    const { mgr, reg } = makeManager()
    reg.register(FineGrainedRoom as any)
    const wsA = mockWs('A')
    const wsClose = mockWs('Close')
    const wsFar = mockWs('Far')
    await mgr.joinRoom('A', 'fine:r', wsA)
    await mgr.joinRoom('Close', 'fine:r', wsClose)
    await mgr.joinRoom('Far', 'fine:r', wsFar)

    const room = (mgr as any).rooms.get('fine:r').instance as FineGrainedRoom
    room.setMemberWorldPosition('A', 0, 0, 0)        // chunk 0:0:0
    room.setMemberWorldPosition('Close', 12, 0, 0)   // chunk 1:0:0 (within range=2)
    room.setMemberWorldPosition('Far', 50, 0, 0)     // chunk 6:0:0 (out of range)

    wsA._sent.length = 0
    wsClose._sent.length = 0
    wsFar._sent.length = 0

    const sent = room.emitInChunkRange('A', 'tick', { n: 1 })
    expect(sent).toBe(1)
    expect(wsClose._sent.length).toBe(1)
    expect(wsFar._sent.length).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('ChunkRoom — diagnostics', () => {
  it('getMemberChunk returns the chunk coord after setMemberChunk', async () => {
    const { mgr, reg } = makeManager()
    reg.register(MinecraftRoom as any)
    await mgr.joinRoom('alice', 'mc:r', mockWs('alice'))
    const room = (mgr as any).rooms.get('mc:r').instance as MinecraftRoom
    room.setMemberChunk('alice', [7, -3, 11])
    expect(room.getMemberChunk('alice')).toEqual([7, -3, 11])
  })

  it('getMemberChunk returns undefined for unplaced member', async () => {
    const { mgr, reg } = makeManager()
    reg.register(MinecraftRoom as any)
    await mgr.joinRoom('ghost', 'mc:r', mockWs('ghost'))
    const room = (mgr as any).rooms.get('mc:r').instance as MinecraftRoom
    expect(room.getMemberChunk('ghost')).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('ChunkRoom — scale', () => {
  it('1000 players spread across a 100×100×100 chunk world, broadcast reaches small subset', async () => {
    const { mgr, reg } = makeManager()
    reg.register(MinecraftRoom as any)
    const wsList: any[] = []
    for (let i = 0; i < 1000; i++) {
      const ws = mockWs(`p${i}`)
      wsList.push(ws)
      await mgr.joinRoom(`p${i}`, 'mc:r', ws)
    }
    const room = (mgr as any).rooms.get('mc:r').instance as MinecraftRoom
    // Spread 1000 players over chunk coords in [0,30)³ → 27000 cells, density ~0.04/cell.
    for (let i = 0; i < 1000; i++) {
      room.setMemberChunk(`p${i}`, [(i * 17) % 30, (i * 23) % 30, (i * 29) % 30])
    }

    for (const ws of wsList) ws._sent.length = 0

    // Place p0 at a known dense spot and broadcast.
    room.setMemberChunk('p0', [15, 15, 15])
    for (const ws of wsList) ws._sent.length = 0

    const sent = room.emitInChunkRange('p0', 'chat', { from: 'p0', text: 'hi' })
    expect(sent).toBeLessThan(100) // far below 999
    console.log(`    [chunk-scale] 1000 players over 30³ chunks, broadcast reached ${sent} peers (${(sent / 1000 * 100).toFixed(1)}% of room)`)
  })
})
