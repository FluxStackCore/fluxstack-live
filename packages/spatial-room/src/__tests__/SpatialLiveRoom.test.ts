// SpatialLiveRoom — end-to-end test against the real LiveRoomManager.
// Verifies that emitNearby() only delivers to members in the surrounding
// cells, that movement reindexes correctly, and that onLeave cleans up.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LiveRoomManager, RoomRegistry, RoomEventBus } from '@fluxstack/live'
import { SpatialLiveRoom } from '../SpatialLiveRoom'

// LiveWSData type is internal — we mimic the shape the manager expects.
type AnyWS = any

vi.mock('@fluxstack/live', async () => {
  const actual = await vi.importActual<any>('@fluxstack/live')
  return actual
})

function mockWs(id: string) {
  // Stores raw frames AND a parsed-event view for binary deliveries. The
  // codec path is msgpack/json-binary; we only assert that *some* frame
  // arrived and (optionally) what its high-level shape is.
  const sent: any[] = []
  const data = {
    connectionId: id,
    components: new Map(),
    subscriptions: new Set(),
    connectedAt: new Date(),
    userId: undefined,
    authContext: { authenticated: false, session: undefined,
      hasRole: () => false, hasAnyRole: () => false, hasAllRoles: () => false,
      hasPermission: () => false, hasAllPermissions: () => false, hasAnyPermission: () => false } as any,
  }
  return {
    send: (m: any) => { sent.push(m) },
    close: () => {},
    data,
    remoteAddress: '127.0.0.1',
    readyState: 1 as const,
    _sent: sent,
  } as AnyWS
}

// ── Test rooms ──────────────────────────────────────────────────────────

interface PlayerState {
  players: Record<string, { x: number; y: number }>
}

class Arena extends SpatialLiveRoom<PlayerState, any, { moved: { id: string; x: number; y: number } }> {
  static roomName = 'arena'
  static defaultState: PlayerState = { players: {} }
  static spatial = { dimensions: 2 as const, cellSize: 100, defaultRange: 1 }
  // Force JSON codec so the test mock WS can introspect message contents.
  // (Default for typed LiveRooms is msgpack binary.)
  static $options = { codec: 'json' as const }

  move(componentId: string, x: number, y: number): number {
    this.setMemberPosition(componentId, [x, y])
    this.state.players[componentId] = { x, y }
    return this.emitNearby(componentId, 'moved', { id: componentId, x, y })
  }
}

class World3D extends SpatialLiveRoom<{}, any, { ping: { from: string } }> {
  static roomName = 'world3d'
  static defaultState = {}
  static spatial = { dimensions: 3 as const, cellSize: 10, defaultRange: 1 }

  place(componentId: string, x: number, y: number, z: number) {
    this.setMemberPosition(componentId, [x, y, z])
  }

  ping(senderId: string): number {
    return this.emitNearby(senderId, 'ping', { from: senderId })
  }
}

function makeManager() {
  const mgr = new LiveRoomManager(new RoomEventBus())
  const reg = new RoomRegistry()
  mgr.roomRegistry = reg
  return { mgr, reg }
}

let consoleSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => { consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { consoleSpy?.mockRestore() })

// ─────────────────────────────────────────────────────────────────────────
describe('SpatialLiveRoom — basic interest filtering', () => {
  it('only sends emitNearby to members in adjacent cells', async () => {
    const { mgr, reg } = makeManager()
    reg.register(Arena as any)

    const wsA = mockWs('A')
    const wsB = mockWs('B')
    const wsFar = mockWs('FAR')
    await mgr.joinRoom('A', 'arena:r', wsA)
    await mgr.joinRoom('B', 'arena:r', wsB)
    await mgr.joinRoom('FAR', 'arena:r', wsFar)

    const room = (mgr as any).rooms.get('arena:r').instance as Arena
    room.move('A', 50, 50)        // cell 0:0
    room.move('B', 150, 50)       // cell 1:0 — adjacent to A
    room.move('FAR', 1000, 1000)  // far away

    wsA._sent.length = 0
    wsB._sent.length = 0
    wsFar._sent.length = 0

    const sent = room.move('A', 60, 60) // A moves slightly within cell 0:0
    // emitNearby excludes self by default → only B receives, not A, not FAR
    expect(sent).toBe(1)
    expect(wsA._sent.length).toBe(0)
    expect(wsB._sent.length).toBe(1)
    expect(wsFar._sent.length).toBe(0)
  })

  it('crossing cells changes who is visible', async () => {
    const { mgr, reg } = makeManager()
    reg.register(Arena as any)

    const wsA = mockWs('A')
    const wsB = mockWs('B')
    const wsC = mockWs('C')
    await mgr.joinRoom('A', 'arena:r', wsA)
    await mgr.joinRoom('B', 'arena:r', wsB)
    await mgr.joinRoom('C', 'arena:r', wsC)

    const room = (mgr as any).rooms.get('arena:r').instance as Arena
    room.move('A', 50, 50)        // cell 0:0
    room.move('B', 150, 50)       // cell 1:0 — adjacent
    room.move('C', 500, 500)      // cell 5:5 — far

    // Reset send counters
    wsA._sent.length = 0
    wsB._sent.length = 0
    wsC._sent.length = 0

    // A moves far to (490, 490) — now adjacent to C (cell 4:4)
    const sent1 = room.move('A', 490, 490)
    // Now A's neighbors include C (cells 4:4-5:5 within range=1 of A's 4:4)
    expect(sent1).toBe(1)
    expect(wsC._sent.length).toBe(1)
    expect(wsB._sent.length).toBe(0)
  })

  it('falls back to global emit when sender has no recorded position', async () => {
    const { mgr, reg } = makeManager()
    reg.register(Arena as any)
    const wsA = mockWs('A')
    const wsB = mockWs('B')
    await mgr.joinRoom('A', 'arena:r', wsA)
    await mgr.joinRoom('B', 'arena:r', wsB)

    const room = (mgr as any).rooms.get('arena:r').instance as Arena
    // Reset send counters after the join handshake so we only count the emit.
    wsA._sent.length = 0
    wsB._sent.length = 0

    // No setMemberPosition for 'A'. emitNearby falls back to room.emit() which
    // broadcasts to ALL members (LiveRoom.emit doesn't exclude any sender).
    const sent = room.emitNearby('A', 'moved' as any, { id: 'A', x: 0, y: 0 })
    expect(sent).toBe(2) // both A and B receive
    expect(wsA._sent.length).toBe(1)
    expect(wsB._sent.length).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('SpatialLiveRoom — emitAtPosition', () => {
  it('reaches members near an arbitrary world point (no sender)', async () => {
    const { mgr, reg } = makeManager()
    reg.register(Arena as any)
    const wsA = mockWs('A')
    const wsB = mockWs('B')
    await mgr.joinRoom('A', 'arena:r', wsA)
    await mgr.joinRoom('B', 'arena:r', wsB)

    const room = (mgr as any).rooms.get('arena:r').instance as Arena
    room.setMemberPosition('A', [50, 50])      // cell 0:0
    room.setMemberPosition('B', [9999, 9999])  // far

    wsA._sent.length = 0
    wsB._sent.length = 0

    const sent = room.emitAtPosition([100, 100], 'moved' as any, { id: 'BOMB', x: 100, y: 100 })
    expect(sent).toBe(1) // only A is near
    expect(wsA._sent.length).toBe(1)
    expect(wsB._sent.length).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('SpatialLiveRoom — 3D', () => {
  it('filters by 3D proximity', async () => {
    const { mgr, reg } = makeManager()
    reg.register(World3D as any)
    const wsA = mockWs('A')
    const wsB = mockWs('B')
    const wsFar = mockWs('FAR')
    await mgr.joinRoom('A', 'world3d:r', wsA)
    await mgr.joinRoom('B', 'world3d:r', wsB)
    await mgr.joinRoom('FAR', 'world3d:r', wsFar)

    const room = (mgr as any).rooms.get('world3d:r').instance as World3D
    room.place('A', 5, 5, 5)        // 0:0:0
    room.place('B', 15, 5, 5)       // 1:0:0 — adjacent
    room.place('FAR', 0, 0, 100)    // 0:0:10 — out of range

    wsA._sent.length = 0
    wsB._sent.length = 0
    wsFar._sent.length = 0

    const sent = room.ping('A')
    expect(sent).toBe(1)
    expect(wsB._sent.length).toBe(1)
    expect(wsFar._sent.length).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('SpatialLiveRoom — cleanup on leave', () => {
  it('onLeave removes the member from the spatial grid', async () => {
    const { mgr, reg } = makeManager()
    reg.register(Arena as any)
    const wsA = mockWs('A')
    await mgr.joinRoom('A', 'arena:r', wsA)
    const room = (mgr as any).rooms.get('arena:r').instance as Arena
    room.setMemberPosition('A', [50, 50])
    expect(room.getOccupiedCellCount()).toBe(1)

    await mgr.leaveRoom('A', 'arena:r')
    expect(room.getOccupiedCellCount()).toBe(0)
  })

  it('cleanupComponent (abrupt disconnect) also removes from grid', async () => {
    const { mgr, reg } = makeManager()
    reg.register(Arena as any)
    const wsA = mockWs('A')
    await mgr.joinRoom('A', 'arena:r', wsA)
    const room = (mgr as any).rooms.get('arena:r').instance as Arena
    room.setMemberPosition('A', [50, 50])

    await mgr.cleanupComponent('A')
    expect(room.getOccupiedCellCount()).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('SpatialLiveRoom — diagnostics', () => {
  it('getVisibleMembers returns the live interest set', async () => {
    const { mgr, reg } = makeManager()
    reg.register(Arena as any)
    await mgr.joinRoom('A', 'arena:r', mockWs('A'))
    await mgr.joinRoom('B', 'arena:r', mockWs('B'))
    await mgr.joinRoom('C', 'arena:r', mockWs('C'))

    const room = (mgr as any).rooms.get('arena:r').instance as Arena
    room.setMemberPosition('A', [50, 50])
    room.setMemberPosition('B', [50, 50])
    room.setMemberPosition('C', [9999, 9999])

    const visible = room.getVisibleMembers('A')
    expect(visible.has('B')).toBe(true)
    expect(visible.has('A')).toBe(false) // self excluded
    expect(visible.has('C')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('SpatialLiveRoom — scale (the whole reason this exists)', () => {
  it('1000 members, broadcasting from one spot only reaches a small subset', async () => {
    const { mgr, reg } = makeManager()
    reg.register(Arena as any)

    const wsList: any[] = []
    for (let i = 0; i < 1000; i++) {
      const ws = mockWs(`p${i}`)
      wsList.push(ws)
      await mgr.joinRoom(`p${i}`, 'arena:r', ws)
    }
    const room = (mgr as any).rooms.get('arena:r').instance as Arena
    // Scatter 1000 players over a 1000×1000 world (cellSize=100 → 10×10 = 100 cells).
    // Average ~10 players per cell → 3×3 neighborhood ~= 90 expected.
    for (let i = 0; i < 1000; i++) {
      room.setMemberPosition(`p${i}`, [(i * 37) % 1000, (i * 89) % 1000])
    }

    // Reset send counters
    for (const ws of wsList) ws._sent.length = 0

    // Pick a sender that we know is at a populated spot.
    room.setMemberPosition('p0', [500, 500])
    for (const ws of wsList) ws._sent.length = 0

    const sent = room.move('p0', 500, 500)
    // Expected: a tiny fraction of 1000, NOT all 999. The exact number
    // depends on PRNG-like distribution, but should be well under 100.
    expect(sent).toBeLessThan(100)
    expect(sent).toBeGreaterThanOrEqual(0)

    // Quantify the win:
    const recipientsActuallyHit = wsList.filter(w => w._sent.length > 0).length
    // (sent counts deliveries; recipientsActuallyHit confirms the count maps to distinct WSs)
    expect(recipientsActuallyHit).toBe(sent)
    console.log(`    [scale] 1000 members in 1000×1000 world (cellSize=100), broadcast reached ${sent} peers (${(sent / 1000 * 100).toFixed(1)}% of room — vs 100% without spatial)`)
  })
})
