// Regression tests for issue #30:
// "$room(RoomClass, id).customMethod() silently returns undefined when no
//  instance exists"
//
// Before the fix, accessing a non-framework property on a typed room proxy
// when no underlying LiveRoom instance existed returned `undefined`. Callers
// would then crash with `TypeError: ... is not a function` buried in
// minified production stacks.
//
// The fix throws a descriptive error pointing to the remediation path
// (call .join() first, or ensure a client has joined).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LiveRoomManager } from '../../rooms/LiveRoomManager'
import { LiveRoom } from '../../rooms/LiveRoom'
import { RoomRegistry } from '../../rooms/RoomRegistry'
import { RoomEventBus } from '../../rooms/RoomEventBus'
import { LiveComponent } from '../../component/LiveComponent'
import { setLiveComponentContext } from '../../component/context'
import { createMockWS } from '../helpers'

vi.mock('../../transport/WsSendBatcher', () => ({
  queueWsMessage: vi.fn(),
  queuePreSerialized: vi.fn(),
  sendImmediate: vi.fn(),
  sendBinaryImmediate: vi.fn(),
}))

vi.mock('../../debug/LiveLogger', () => ({
  liveLog: vi.fn(),
  liveWarn: vi.fn(),
  registerComponentLogging: vi.fn(),
  unregisterComponentLogging: vi.fn(),
}))

type LeaderboardEvents = { 'leaderboard:updated': { top: number[] } }

class LeaderboardRoom extends LiveRoom<{ scores: number[] }, {}, LeaderboardEvents> {
  static roomName = 'issue30-leaderboard'
  static defaultState = { scores: [] }
  static defaultMeta = {}

  broadcastUpdate(top: number[]): number {
    return this.emit('leaderboard:updated', { top })
  }

  nonFunctionProperty = 42
}

function setupManager() {
  const roomEvents = new RoomEventBus()
  const manager = new LiveRoomManager(roomEvents)
  const registry = new RoomRegistry()
  registry.register(LeaderboardRoom as any)
  manager.roomRegistry = registry
  setLiveComponentContext({ roomEvents, roomManager: manager })
  return { manager, roomEvents }
}

describe('Issue #30: typed room proxy with no live instance', () => {
  let cleanup: (() => Promise<void>) | null = null
  afterEach(async () => {
    if (cleanup) { await cleanup(); cleanup = null }
  })

  it('throws a descriptive error when calling a custom method before any join', () => {
    setupManager()

    class Game extends LiveComponent<{ kills: number }> {
      static componentName = 'Issue30Game'
      static publicActions = [] as const
      static defaultState = { kills: 0 }
    }

    const ws = createMockWS()
    const comp = new Game({}, ws as any)

    const room = comp.$room(LeaderboardRoom as any, 'global') as any

    expect(() => room.broadcastUpdate([1, 2, 3])).toThrow(
      /Room 'issue30-leaderboard:global' has no live instance/,
    )
    expect(() => room.broadcastUpdate([1, 2, 3])).toThrow(/broadcastUpdate/)
  })

  it('error message names the room class and instance id for discoverability', () => {
    setupManager()

    class Game extends LiveComponent<{}> {
      static componentName = 'Issue30Game2'
      static publicActions = [] as const
      static defaultState = {}
    }

    const ws = createMockWS()
    const comp = new Game({}, ws as any)
    const room = comp.$room(LeaderboardRoom as any, 'season-2') as any

    try {
      room.broadcastUpdate([])
      throw new Error('expected access to throw')
    } catch (err) {
      const msg = (err as Error).message
      expect(msg).toContain('issue30-leaderboard')
      expect(msg).toContain('season-2')
      expect(msg).toContain('.join()')
    }
  })

  it('still throws on custom non-function property access when no instance', () => {
    // Even a property read (not a method call) should fail loudly — silent
    // undefined here was equally misleading (e.g. logging it would suggest
    // the field legitimately does not exist).
    setupManager()

    class Game extends LiveComponent<{}> {
      static componentName = 'Issue30Game3'
      static publicActions = [] as const
      static defaultState = {}
    }

    const ws = createMockWS()
    const comp = new Game({}, ws as any)
    const room = comp.$room(LeaderboardRoom as any, 'r') as any

    expect(() => room.nonFunctionProperty).toThrow(/no live instance/)
  })

  it('framework keys (id, state, meta, memberCount) do NOT throw when no instance', async () => {
    // The fix must only affect custom properties. Framework keys are in
    // TYPED_RESERVED_KEYS and bypass the instance fallback entirely.
    setupManager()

    class Game extends LiveComponent<{}> {
      static componentName = 'Issue30Game4'
      static publicActions = [] as const
      static defaultState = {}
    }

    const ws = createMockWS()
    const comp = new Game({}, ws as any)
    const room = comp.$room(LeaderboardRoom as any, 'r') as any

    expect(() => room.id).not.toThrow()
    expect(room.id).toBe('issue30-leaderboard:r')
    expect(() => room.memberCount).not.toThrow()
    expect(room.memberCount).toBe(0)
    // `meta` has its own explicit throw path (pre-existing behaviour), not
    // the issue #30 one — just assert the proxy doesn't double-throw.
    expect(() => room.meta).toThrow(/not found or not backed by a LiveRoom/)
  })

  it('Symbol access (e.g. then for Promise interop) does NOT throw', () => {
    // Without this guard, `Promise.resolve(typedRoom)` would throw during
    // await unwrapping. Symbols are in the reserved-keys shortcut.
    setupManager()

    class Game extends LiveComponent<{}> {
      static componentName = 'Issue30Game5'
      static publicActions = [] as const
      static defaultState = {}
    }

    const ws = createMockWS()
    const comp = new Game({}, ws as any)
    const room = comp.$room(LeaderboardRoom as any, 'r') as any

    expect(() => room[Symbol.toPrimitive]).not.toThrow()
    expect(() => room.then).not.toThrow()
  })

  it('after join(), custom methods work normally (regression check)', async () => {
    const { manager } = setupManager()

    class Game extends LiveComponent<{}> {
      static componentName = 'Issue30Game6'
      static publicActions = [] as const
      static defaultState = {}
    }

    const ws = createMockWS()
    const comp = new Game({}, ws as any)
    const room = comp.$room(LeaderboardRoom as any, 'r') as any

    await room.join()

    expect(() => room.broadcastUpdate([1, 2, 3])).not.toThrow()
    expect(room.nonFunctionProperty).toBe(42)

    cleanup = async () => { await manager.cleanupComponent((comp as any).id) }
  })
})
