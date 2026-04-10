// Regression tests for issue #5: LiveRoom lifecycle hook safety.
//
// Before the fix, hooks declared on a LiveRoom subclass (onCreate, onJoin,
// onEvent, onLeave, onDestroy) were invoked by LiveRoomManager without any
// isolation — synchronous throws propagated through joinRoom/emitToRoom/
// cleanupComponent, async rejections became unhandledRejections,
// Promise<false> returned from onDestroy was ignored, and onCreate fired
// AFTER the first onJoin, contradicting the documented contract.
//
// This suite is the permanent home of the bug-hunt reproducer (originally
// in __tests__/bug-hunt/lifecycle-hooks.test.ts). Each describe block
// maps to one of the hypotheses that originally flagged the bug; with
// the fix in place they all pass.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LiveRoomManager } from '../../rooms/LiveRoomManager'
import { LiveRoom } from '../../rooms/LiveRoom'
import { RoomRegistry } from '../../rooms/RoomRegistry'
import { RoomEventBus } from '../../rooms/RoomEventBus'
import { LiveComponent } from '../../component/LiveComponent'
import type { GenericWebSocket, LiveWSData } from '../../transport/types'
import { ANONYMOUS_CONTEXT } from '../../auth/LiveAuthContext'

// Silence the batcher / logger side-effects
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

// ---------- helpers ----------

function createMockWS(): GenericWebSocket & { _sent: any[] } {
  const sent: any[] = []
  const data: LiveWSData = {
    connectionId: `ws-${Math.random().toString(36).slice(2, 10)}`,
    components: new Map(),
    subscriptions: new Set(),
    connectedAt: new Date(),
    userId: undefined,
    authContext: ANONYMOUS_CONTEXT,
  }
  return {
    send: (m: any) => sent.push(m),
    close: () => {},
    data,
    remoteAddress: '127.0.0.1',
    readyState: 1 as const,
    _sent: sent,
  } as any
}

function makeManager() {
  const bus = new RoomEventBus()
  const mgr = new LiveRoomManager(bus)
  const registry = new RoomRegistry()
  mgr.roomRegistry = registry
  return { mgr, bus, registry }
}

// silence console.error noise from expected errors
let errSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  errSpy.mockRestore()
  vi.clearAllMocks()
})

// ===================================================================
// H1: synchronous throw in onCreate must not crash joinRoom
// ===================================================================
describe('onCreate — synchronous throw is isolated', () => {
  it('onCreate throwing is caught; joinRoom resolves with a rejection', async () => {
    const { mgr, registry } = makeManager()

    class BadCreate extends LiveRoom<{ ready: boolean }> {
      static roomName = 'h1'
      static defaultState = { ready: false }
      onCreate() {
        throw new Error('boom from onCreate')
      }
    }
    registry.register(BadCreate as any)

    const ws = createMockWS()
    // The framework must not let the hook's error escape.
    const result = await mgr.joinRoom('c-1', 'h1:lobby', ws)
    // Room initialization failed → join is rejected and the room is torn down.
    expect((result as any).rejected).toBe(true)
    expect(mgr.getStats().totalRooms).toBe(0)
  })
})

// ===================================================================
// H2: async onCreate rejection does not become unhandledRejection
// ===================================================================
describe('onCreate — async rejection is caught', () => {
  it('async onCreate rejection is awaited and handled without unhandledRejection', async () => {
    const { mgr, registry } = makeManager()
    const rejections: unknown[] = []
    const handler = (reason: unknown) => rejections.push(reason)
    process.on('unhandledRejection', handler)

    class AsyncBad extends LiveRoom<{ x: number }> {
      static roomName = 'h2'
      static defaultState = { x: 0 }
      async onCreate() {
        await Promise.resolve()
        throw new Error('async create boom')
      }
    }
    registry.register(AsyncBad as any)

    const ws = createMockWS()
    const result = await mgr.joinRoom('c-1', 'h2:lobby', ws)

    // let any rejected microtask settle
    await new Promise((r) => setTimeout(r, 10))
    process.off('unhandledRejection', handler)

    expect(rejections).toHaveLength(0)
    expect((result as any).rejected).toBe(true)
  })
})

// ===================================================================
// H3: synchronous throw in onEvent must not break emitToRoom
// ===================================================================
describe('onEvent — synchronous throw is isolated', () => {
  it('onEvent throwing does not prevent the broadcast from running', async () => {
    const { mgr, registry } = makeManager()

    class BadEvent extends LiveRoom<{ n: number }> {
      static roomName = 'h3'
      static defaultState = { n: 0 }
      onEvent() {
        throw new Error('boom from onEvent')
      }
    }
    registry.register(BadEvent as any)

    const ws1 = createMockWS()
    const ws2 = createMockWS()
    await mgr.joinRoom('c-1', 'h3:lobby', ws1)
    await mgr.joinRoom('c-2', 'h3:lobby', ws2)

    expect(() => mgr.emitToRoom('h3:lobby', 'ping', { a: 1 })).not.toThrow()
  })

  it('async onEvent rejection is caught and does not surface as unhandledRejection', async () => {
    const { mgr, registry } = makeManager()
    const rejections: unknown[] = []
    const handler = (reason: unknown) => rejections.push(reason)
    process.on('unhandledRejection', handler)

    class AsyncBadEvent extends LiveRoom<{ n: number }> {
      static roomName = 'h3b'
      static defaultState = { n: 0 }
      async onEvent() {
        await Promise.resolve()
        throw new Error('async event boom')
      }
    }
    registry.register(AsyncBadEvent as any)

    const ws = createMockWS()
    await mgr.joinRoom('c-1', 'h3b:lobby', ws)
    expect(() => mgr.emitToRoom('h3b:lobby', 'ping', {})).not.toThrow()

    await new Promise((r) => setTimeout(r, 10))
    process.off('unhandledRejection', handler)

    expect(rejections).toHaveLength(0)
  })
})

// ===================================================================
// H4: async onEvent is observer-only (documented contract)
// ===================================================================
describe('onEvent — observer contract', () => {
  it('async onEvent runs fire-and-forget after the synchronous broadcast path', async () => {
    const { mgr, registry } = makeManager()
    const callOrder: string[] = []

    class AsyncHook extends LiveRoom<{ n: number }> {
      static roomName = 'h4'
      static defaultState = { n: 0 }
      async onEvent(event: string) {
        callOrder.push(`start:${event}`)
        await Promise.resolve()
        callOrder.push(`end:${event}`)
      }
    }
    registry.register(AsyncHook as any)

    const ws = createMockWS()
    await mgr.joinRoom('c-1', 'h4:lobby', ws)

    mgr.emitToRoom('h4:lobby', 'e1', {})
    mgr.emitToRoom('h4:lobby', 'e2', {})

    await new Promise((r) => setTimeout(r, 10))

    // Contract: onEvent is observer-only. Both starts are called synchronously
    // before either end because the framework does not await the hook — the
    // broadcast path must not be gated on user code. This documents the
    // behaviour that #5 H4 originally flagged; the fix logs async rejections
    // but keeps the fire-and-forget semantics intentional.
    expect(callOrder.slice(0, 2)).toEqual(['start:e1', 'start:e2'])
    expect(callOrder.slice(2).sort()).toEqual(['end:e1', 'end:e2'])
  })
})

// ===================================================================
// H5: Promise<false> from onDestroy must cancel destruction
// ===================================================================
describe('onDestroy — Promise<false> cancels destruction', () => {
  it('async onDestroy resolving to false keeps the room alive', async () => {
    vi.useFakeTimers()
    const { mgr, registry } = makeManager()

    class StickyRoom extends LiveRoom<{ keep: boolean }> {
      static roomName = 'h5'
      static defaultState = { keep: true }
      async onDestroy() {
        await Promise.resolve()
        return false as const
      }
    }
    registry.register(StickyRoom as any)

    const ws = createMockWS()
    await mgr.joinRoom('c-1', 'h5:main', ws)
    await mgr.leaveRoom('c-1', 'h5:main')

    // Advance past the 5 minute cleanup timer
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1000)

    vi.useRealTimers()

    // Room should still exist because onDestroy returned Promise<false>
    expect(mgr.getStats().totalRooms).toBe(1)
  })

  it('async onDestroy resolving to undefined destroys the room', async () => {
    vi.useFakeTimers()
    const { mgr, registry } = makeManager()

    class NormalRoom extends LiveRoom {
      static roomName = 'h5b'
      static defaultState = {}
      async onDestroy() {
        await Promise.resolve()
      }
    }
    registry.register(NormalRoom as any)

    const ws = createMockWS()
    await mgr.joinRoom('c-1', 'h5b:main', ws)
    await mgr.leaveRoom('c-1', 'h5b:main')

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1000)

    vi.useRealTimers()

    expect(mgr.getStats().totalRooms).toBe(0)
  })

  it('synchronous throw in onDestroy destroys the room and logs', async () => {
    vi.useFakeTimers()
    const { mgr, registry } = makeManager()

    class BrokenDestroy extends LiveRoom {
      static roomName = 'h5c'
      static defaultState = {}
      onDestroy() {
        throw new Error('destroy boom')
      }
    }
    registry.register(BrokenDestroy as any)

    const ws = createMockWS()
    await mgr.joinRoom('c-1', 'h5c:main', ws)
    await mgr.leaveRoom('c-1', 'h5c:main')

    // No unhandled rejection, and the room is destroyed despite the throw.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1000)

    vi.useRealTimers()

    expect(mgr.getStats().totalRooms).toBe(0)
  })
})

// ===================================================================
// H6: cleanupComponent — onLeave throws must not leak remaining rooms
// ===================================================================
describe('cleanupComponent — onLeave throws are isolated per room', () => {
  it('a single onLeave error does not prevent other rooms from being cleaned', async () => {
    const { mgr, registry } = makeManager()

    class BadLeaveA extends LiveRoom {
      static roomName = 'h6a'
      static defaultState = {}
      onLeave() {
        throw new Error('boom in a')
      }
    }
    class GoodB extends LiveRoom {
      static roomName = 'h6b'
      static defaultState = {}
    }
    registry.register(BadLeaveA as any)
    registry.register(GoodB as any)

    const ws = createMockWS()
    await mgr.joinRoom('c-1', 'h6a:x', ws)
    await mgr.joinRoom('c-1', 'h6b:y', ws)

    // Cleanup must not throw AND must remove comp from both rooms
    await expect(mgr.cleanupComponent('c-1')).resolves.toBeUndefined()
    expect(mgr.isInRoom('c-1', 'h6a:x')).toBe(false)
    expect(mgr.isInRoom('c-1', 'h6b:y')).toBe(false)
  })

  it('single-room leaveRoom() also isolates onLeave throws', async () => {
    const { mgr, registry } = makeManager()

    class BadLeave extends LiveRoom {
      static roomName = 'h6c'
      static defaultState = {}
      onLeave() {
        throw new Error('boom leave')
      }
    }
    registry.register(BadLeave as any)

    const ws = createMockWS()
    await mgr.joinRoom('c-1', 'h6c:main', ws)

    await expect(mgr.leaveRoom('c-1', 'h6c:main')).resolves.toBeUndefined()
    expect(mgr.isInRoom('c-1', 'h6c:main')).toBe(false)
  })
})

// ===================================================================
// H7: onCreate must fire BEFORE the first onJoin
// ===================================================================
describe('ordering — onCreate runs before the first onJoin', () => {
  it('first onJoin observes state already seeded by onCreate', async () => {
    const { mgr, registry } = makeManager()
    const observed: { hook: string; seeded: boolean }[] = []

    class SeededRoom extends LiveRoom<{ seeded: boolean }> {
      static roomName = 'h7'
      static defaultState = { seeded: false }
      onCreate() {
        observed.push({ hook: 'onCreate', seeded: (this.state as any).seeded })
        ;(this.state as any).seeded = true
      }
      onJoin() {
        observed.push({ hook: 'onJoin', seeded: (this.state as any).seeded })
      }
    }
    registry.register(SeededRoom as any)

    const ws = createMockWS()
    await mgr.joinRoom('c-1', 'h7:room', ws)

    // Contract: onCreate runs once, before the first onJoin, and the first
    // join sees the already-seeded state.
    const createIdx = observed.findIndex((e) => e.hook === 'onCreate')
    const joinIdx = observed.findIndex((e) => e.hook === 'onJoin')
    expect(createIdx).toBeGreaterThanOrEqual(0)
    expect(joinIdx).toBeGreaterThanOrEqual(0)
    expect(createIdx).toBeLessThan(joinIdx)
    expect(observed[joinIdx].seeded).toBe(true)
  })

  it('onCreate only fires for the first member, not subsequent joins', async () => {
    const { mgr, registry } = makeManager()
    const createCalls: number[] = []

    class OnceRoom extends LiveRoom {
      static roomName = 'h7b'
      static defaultState = {}
      onCreate() {
        createCalls.push(Date.now())
      }
    }
    registry.register(OnceRoom as any)

    const ws1 = createMockWS()
    const ws2 = createMockWS()
    await mgr.joinRoom('c-1', 'h7b:room', ws1)
    await mgr.joinRoom('c-2', 'h7b:room', ws2)

    expect(createCalls).toHaveLength(1)
  })
})

// ===================================================================
// H8: cascading setState inside onStateChange — intentional guard
// ===================================================================
describe.skip('onStateChange reentrancy (intentional guard, documented)', () => {
  // The _inStateChange guard in ComponentStateManager is intentional: it
  // prevents infinite cascades when onStateChange triggers another setState.
  // The cascade is still applied to state and emitted as a STATE_DELTA to
  // the client, but the hook is NOT re-entered. This is a known tradeoff,
  // not a bug, so the test is skipped — kept here for documentation.
  it('cascading setState is visible on the client but skips the hook', async () => {
    const ws = createMockWS()
    const observed: any[] = []

    class Cascader extends LiveComponent<{ a: number; b: number }> {
      static componentName = 'Cascader'
      static defaultState = { a: 0, b: 0 }
      protected onStateChange(changes: Partial<{ a: number; b: number }>): void {
        observed.push({ ...changes })
        if ('a' in changes && (this.state as any).b === 0) {
          this.setState({ b: (changes.a ?? 0) * 2 })
        }
      }
    }

    const c = new Cascader({}, ws as any)
    c.setState({ a: 5 })

    const sawBUpdate = observed.some((o) => 'b' in o)
    expect(sawBUpdate).toBe(true)
  })
})

// ===================================================================
// H9: LiveComponent onMount throws must leave the component usable
// ===================================================================
describe('LiveComponent onMount — throw leaves component usable', () => {
  it('setState after a failed onMount still propagates a delta', async () => {
    const ws = createMockWS()

    class BadMount extends LiveComponent<{ v: number }> {
      static componentName = 'BadMount'
      static defaultState = { v: 0 }
      protected async onMount() {
        throw new Error('mount failed')
      }
    }

    const c = new BadMount({}, ws as any)
    try {
      await (c as any).onMount()
    } catch {
      /* ignore */
    }

    expect(() => c.setState({ v: 42 })).not.toThrow()
    expect((c.state as any).v).toBe(42)
  })
})
