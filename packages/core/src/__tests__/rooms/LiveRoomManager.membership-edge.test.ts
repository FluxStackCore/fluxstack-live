// Edge-case coverage for RoomLeaveContext.membership (#36).
// Covers async hooks, multi-room scenarios, mutation patterns, throw-isolation,
// and the interaction with onJoin rejection.

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

describe('membership — async hooks (#36)', () => {
  it('async onJoin mutations are visible in async onLeave', async () => {
    const { mgr, registry } = makeManager()
    let captured: any = null

    class R extends LiveRoom<{ x: number }> {
      static roomName = 'async-r'
      static defaultState = { x: 0 }
      async onJoin(ctx: any) {
        await Promise.resolve()
        ctx.membership.token = 'abc-' + ctx.payload.id
      }
      async onLeave(ctx: any) {
        await Promise.resolve()
        captured = ctx.membership
      }
    }
    registry.register(R as any)

    await mgr.joinRoom('c-1', 'async-r:room', createMockWS(), undefined, undefined, {
      payload: { id: 42 },
    })
    await mgr.leaveRoom('c-1', 'async-r:room')

    expect(captured).toEqual({ token: 'abc-42' })
  })

  it('membership is NOT persisted when onJoin rejects (false)', async () => {
    const { mgr, registry } = makeManager()
    const leaves: any[] = []

    class R extends LiveRoom<{ x: number }> {
      static roomName = 'reject-r'
      static defaultState = { x: 0 }
      onJoin(ctx: any): false {
        ctx.membership.shouldNotPersist = true
        return false // reject
      }
      onLeave(ctx: any) { leaves.push(ctx) }
    }
    registry.register(R as any)

    const result = await mgr.joinRoom('c-1', 'reject-r:room', createMockWS())
    expect((result as any).rejected).toBe(true)

    // No member was actually added → leaveRoom for this comp is a no-op,
    // onLeave must not fire.
    await mgr.leaveRoom('c-1', 'reject-r:room')
    expect(leaves).toHaveLength(0)
  })

  it('membership is NOT persisted when onJoin throws', async () => {
    const { mgr, registry } = makeManager()
    const leaves: any[] = []

    class R extends LiveRoom<{ x: number }> {
      static roomName = 'throw-r'
      static defaultState = { x: 0 }
      onJoin(ctx: any) {
        ctx.membership.bad = true
        throw new Error('boom')
      }
      onLeave(ctx: any) { leaves.push(ctx) }
    }
    registry.register(R as any)

    const result = await mgr.joinRoom('c-1', 'throw-r:room', createMockWS())
    expect((result as any).rejected).toBe(true)

    await mgr.leaveRoom('c-1', 'throw-r:room')
    expect(leaves).toHaveLength(0)
  })
})

describe('membership — multi-room cleanup (#36)', () => {
  it('cleanupComponent surfaces the correct membership per room', async () => {
    const { mgr, registry } = makeManager()
    const leaves: Array<{ roomId: string; membership: any }> = []

    class Lobby extends LiveRoom<{ x: number }> {
      static roomName = 'lobby'
      static defaultState = { x: 0 }
      onJoin(ctx: any) { ctx.membership.role = 'lobby-' + ctx.payload.name }
      onLeave(ctx: any) { leaves.push({ roomId: this.id, membership: ctx.membership }) }
    }
    class Game extends LiveRoom<{ y: number }> {
      static roomName = 'game'
      static defaultState = { y: 0 }
      onJoin(ctx: any) { ctx.membership.role = 'game-' + ctx.payload.name }
      onLeave(ctx: any) { leaves.push({ roomId: this.id, membership: ctx.membership }) }
    }
    registry.register(Lobby as any)
    registry.register(Game as any)

    await mgr.joinRoom('c-1', 'lobby:main', createMockWS(), undefined, undefined, {
      payload: { name: 'Alice' },
    })
    await mgr.joinRoom('c-1', 'game:arena', createMockWS(), undefined, undefined, {
      payload: { name: 'Alice' },
    })

    await mgr.cleanupComponent('c-1')

    expect(leaves).toHaveLength(2)
    const byRoom = Object.fromEntries(leaves.map(l => [l.roomId, l.membership]))
    expect(byRoom['lobby:main']).toEqual({ role: 'lobby-Alice' })
    expect(byRoom['game:arena']).toEqual({ role: 'game-Alice' })
  })

  it('a throwing onLeave does not corrupt subsequent rooms membership', async () => {
    const { mgr, registry } = makeManager()
    const leaves: any[] = []

    class A extends LiveRoom<{ x: number }> {
      static roomName = 'a'
      static defaultState = { x: 0 }
      onJoin(ctx: any) { ctx.membership.tag = 'A' }
      onLeave(_ctx: any) { throw new Error('A failed') }
    }
    class B extends LiveRoom<{ y: number }> {
      static roomName = 'b'
      static defaultState = { y: 0 }
      onJoin(ctx: any) { ctx.membership.tag = 'B' }
      onLeave(ctx: any) { leaves.push(ctx.membership) }
    }
    registry.register(A as any)
    registry.register(B as any)

    await mgr.joinRoom('c-1', 'a:r', createMockWS())
    await mgr.joinRoom('c-1', 'b:r', createMockWS())

    await mgr.cleanupComponent('c-1')

    expect(leaves).toEqual([{ tag: 'B' }])
  })
})

describe('membership — mutation patterns (#36)', () => {
  it('supports replacing membership content during the membership lifetime', async () => {
    const { mgr, registry } = makeManager()
    let snapshot: any = null

    class R extends LiveRoom<{ score: number }> {
      static roomName = 'mut'
      static defaultState = { score: 0 }
      onJoin(ctx: any) { ctx.membership.score = 0; ctx.membership.id = 'p-1' }
      onLeave(ctx: any) { snapshot = { ...ctx.membership } }
    }
    registry.register(R as any)

    await mgr.joinRoom('c-1', 'mut:r', createMockWS())

    // Domain code mutates membership outside the lifecycle hooks via the
    // member entry — verify by mutating the underlying map (room-keyed by
    // componentId) and confirming onLeave sees the mutation.
    const room = (mgr as any).rooms.get('mut:r')
    room.members.get('c-1').membership.score = 99

    await mgr.leaveRoom('c-1', 'mut:r')
    expect(snapshot).toEqual({ score: 99, id: 'p-1' })
  })

  it('membership for componentId B is independent of componentId A in the same room', async () => {
    const { mgr, registry } = makeManager()
    const seen: Record<string, any> = {}

    class R extends LiveRoom<{ x: number }> {
      static roomName = 'iso'
      static defaultState = { x: 0 }
      onJoin(ctx: any) { ctx.membership.who = ctx.payload.who }
      onLeave(ctx: any) { seen[ctx.componentId] = ctx.membership }
    }
    registry.register(R as any)

    await mgr.joinRoom('a', 'iso:r', createMockWS(), undefined, undefined, { payload: { who: 'A' } })
    await mgr.joinRoom('b', 'iso:r', createMockWS(), undefined, undefined, { payload: { who: 'B' } })

    // Mutate A's membership; B should not see the mutation.
    const room = (mgr as any).rooms.get('iso:r')
    room.members.get('a').membership.who = 'A-MUTATED'

    await mgr.leaveRoom('a', 'iso:r')
    await mgr.leaveRoom('b', 'iso:r')

    expect(seen['a']).toEqual({ who: 'A-MUTATED' })
    expect(seen['b']).toEqual({ who: 'B' })
  })
})

describe('membership — leave reason variants (#36)', () => {
  it('preserves membership on explicit leave', async () => {
    const { mgr, registry } = makeManager()
    let r: any = null
    class R extends LiveRoom<{ x: number }> {
      static roomName = 'lr'
      static defaultState = { x: 0 }
      onJoin(ctx: any) { ctx.membership.id = 'leave' }
      onLeave(ctx: any) { r = ctx }
    }
    registry.register(R as any)
    await mgr.joinRoom('c', 'lr:r', createMockWS())
    await mgr.leaveRoom('c', 'lr:r', 'leave')
    expect(r.reason).toBe('leave')
    expect(r.membership).toEqual({ id: 'leave' })
  })

  it('preserves membership on cleanup reason', async () => {
    const { mgr, registry } = makeManager()
    let r: any = null
    class R extends LiveRoom<{ x: number }> {
      static roomName = 'cr'
      static defaultState = { x: 0 }
      onJoin(ctx: any) { ctx.membership.id = 'cleanup' }
      onLeave(ctx: any) { r = ctx }
    }
    registry.register(R as any)
    await mgr.joinRoom('c', 'cr:r', createMockWS())
    await mgr.leaveRoom('c', 'cr:r', 'cleanup')
    expect(r.reason).toBe('cleanup')
    expect(r.membership).toEqual({ id: 'cleanup' })
  })
})
