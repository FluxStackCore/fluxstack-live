// Regression tests for issue #36: RoomLeaveContext.membership.
//
// Before the fix, onLeave only received { componentId, userId?, reason }. Rooms
// keying their state by an app id (e.g. `state.players[playerId]`) had no way
// to find the entry to remove on abrupt disconnect, because `destroy()` on
// the component doesn't always run.
//
// The fix threads a per-member metadata bag through the lifecycle: onJoin can
// stash domain ids into ctx.membership, and the same object is handed back
// to onLeave for cleanup.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LiveRoomManager } from '../../rooms/LiveRoomManager'
import { LiveRoom } from '../../rooms/LiveRoom'
import { RoomRegistry } from '../../rooms/RoomRegistry'
import { RoomEventBus } from '../../rooms/RoomEventBus'
import type { GenericWebSocket, LiveWSData } from '../../transport/types'
import { ANONYMOUS_CONTEXT } from '../../auth/LiveAuthContext'

vi.mock('../../transport/WsSendBatcher', () => ({
  queueWsMessage: vi.fn(),
  queuePreSerialized: vi.fn(),
  sendImmediate: vi.fn(),
  setResyncHandler: vi.fn(),
  sendBinaryImmediate: vi.fn(),
}))
vi.mock('../../debug/LiveLogger', () => ({
  liveLog: vi.fn(),
  liveWarn: vi.fn(),
  registerComponentLogging: vi.fn(),
  unregisterComponentLogging: vi.fn(),
}))

function createMockWS(): GenericWebSocket {
  const data: LiveWSData = {
    connectionId: `ws-${Math.random().toString(36).slice(2, 10)}`,
    components: new Map(),
    subscriptions: new Set(),
    connectedAt: new Date(),
    userId: undefined,
    authContext: ANONYMOUS_CONTEXT,
  }
  return {
    send: () => {},
    close: () => {},
    data,
    remoteAddress: '127.0.0.1',
    readyState: 1 as const,
  } as any
}

function makeManager() {
  const bus = new RoomEventBus()
  const mgr = new LiveRoomManager(bus)
  const registry = new RoomRegistry()
  mgr.roomRegistry = registry
  return { mgr, registry }
}

let errSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => { errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { errSpy.mockRestore(); vi.clearAllMocks() })

interface PlayerState { players: Record<string, { id: string; name: string }> }

describe('RoomLeaveContext.membership (#36)', () => {
  it('onLeave receives the membership bag populated by onJoin (explicit leave)', async () => {
    const { mgr, registry } = makeManager()
    const leaveCalls: any[] = []

    class TrophyRoom extends LiveRoom<PlayerState> {
      static roomName = 'trophy'
      static defaultState = { players: {} }
      onJoin(ctx: any) {
        const playerId = ctx.payload?.playerId
        ctx.membership.playerId = playerId
        this.state.players[playerId] = { id: playerId, name: ctx.payload.name }
      }
      onLeave(ctx: any) {
        leaveCalls.push({ componentId: ctx.componentId, membership: ctx.membership })
        delete this.state.players[ctx.membership.playerId]
      }
    }
    registry.register(TrophyRoom as any)

    await mgr.joinRoom('comp-1', 'trophy:lobby', createMockWS(), undefined, undefined, {
      payload: { playerId: 'p-42', name: 'Alice' },
    })

    const before = (mgr as any).rooms.get('trophy:lobby')!.state.players
    expect(before['p-42']).toEqual({ id: 'p-42', name: 'Alice' })

    await mgr.leaveRoom('comp-1', 'trophy:lobby', 'leave')

    expect(leaveCalls).toEqual([
      { componentId: 'comp-1', membership: { playerId: 'p-42' } },
    ])
    const after = (mgr as any).rooms.get('trophy:lobby')!.state.players
    expect(after['p-42']).toBeUndefined()
  })

  it('membership is preserved on abrupt disconnect (cleanupComponent path)', async () => {
    const { mgr, registry } = makeManager()
    const leaveCalls: any[] = []

    class TrophyRoom extends LiveRoom<PlayerState> {
      static roomName = 'trophy'
      static defaultState = { players: {} }
      onJoin(ctx: any) {
        ctx.membership.playerId = ctx.payload.playerId
        this.state.players[ctx.payload.playerId] = { id: ctx.payload.playerId, name: 'x' }
      }
      onLeave(ctx: any) { leaveCalls.push(ctx) }
    }
    registry.register(TrophyRoom as any)

    await mgr.joinRoom('comp-1', 'trophy:lobby', createMockWS(), undefined, undefined, {
      payload: { playerId: 'p-99' },
    })

    await mgr.cleanupComponent('comp-1')

    expect(leaveCalls).toHaveLength(1)
    expect(leaveCalls[0].reason).toBe('disconnect')
    expect(leaveCalls[0].membership).toEqual({ playerId: 'p-99' })
  })

  it('membership defaults to {} when onJoin does not populate it', async () => {
    const { mgr, registry } = makeManager()
    let captured: any = null

    class SimpleRoom extends LiveRoom<{ ok: boolean }> {
      static roomName = 'simple'
      static defaultState = { ok: true }
      onLeave(ctx: any) { captured = ctx.membership }
    }
    registry.register(SimpleRoom as any)

    await mgr.joinRoom('c-1', 'simple:room', createMockWS())
    await mgr.leaveRoom('c-1', 'simple:room')

    expect(captured).toEqual({})
  })

  it('different members have independent membership bags', async () => {
    const { mgr, registry } = makeManager()
    const seen: any[] = []

    class R extends LiveRoom<{ x: number }> {
      static roomName = 'multi'
      static defaultState = { x: 0 }
      onJoin(ctx: any) { ctx.membership.tag = ctx.payload.tag }
      onLeave(ctx: any) { seen.push(ctx.membership.tag) }
    }
    registry.register(R as any)

    await mgr.joinRoom('a', 'multi:r', createMockWS(), undefined, undefined, { payload: { tag: 'A' } })
    await mgr.joinRoom('b', 'multi:r', createMockWS(), undefined, undefined, { payload: { tag: 'B' } })

    await mgr.leaveRoom('a', 'multi:r')
    await mgr.leaveRoom('b', 'multi:r')

    expect(seen).toEqual(['A', 'B'])
  })
})
