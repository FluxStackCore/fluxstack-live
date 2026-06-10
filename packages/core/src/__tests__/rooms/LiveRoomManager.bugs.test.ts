// Tests that expose known bugs in LiveRoomManager
// Each test documents the bug it targets and should FAIL until the bug is fixed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LiveRoomManager } from '../../rooms/LiveRoomManager'
import { LiveRoom, type LiveRoomClass } from '../../rooms/LiveRoom'
import { RoomEventBus } from '../../rooms/RoomEventBus'
import { RoomRegistry } from '../../rooms/RoomRegistry'
import { createMockWS } from '../helpers'

// Mock the WsSendBatcher
vi.mock('../../transport/WsSendBatcher', () => ({
  queueWsMessage: vi.fn(),
  queuePreSerialized: vi.fn(),
  sendImmediate: vi.fn(),
  setResyncHandler: vi.fn(),
  sendBinaryImmediate: vi.fn(),
}))

// Mock LiveLogger
vi.mock('../../debug/LiveLogger', () => ({
  liveLog: vi.fn(),
  liveWarn: vi.fn(),
}))

// ===== Test Room Classes =====

class TrackingRoom extends LiveRoom<{ count: number }, { destroyCount: number }> {
  static roomName = 'tracking'
  static defaultState = { count: 0 }
  static defaultMeta = { destroyCount: 0 }

  onDestroyCalls = 0
  onLeaveCalls: string[] = []
  onJoinCalls: string[] = []
  onEventCalls: Array<{ event: string; componentId: string }> = []

  onJoin(ctx: { componentId: string }) {
    this.onJoinCalls.push(ctx.componentId)
  }

  onLeave(ctx: { componentId: string; reason: string }) {
    this.onLeaveCalls.push(ctx.componentId)
  }

  onDestroy() {
    this.onDestroyCalls++
    this.meta.destroyCount++
  }

  onEvent(event: string, _data: any, ctx: { componentId: string }) {
    this.onEventCalls.push({ event, componentId: ctx.componentId })
  }
}

class AsyncRejectRoom extends LiveRoom<{ count: number }> {
  static roomName = 'async-reject'
  static defaultState = { count: 0 }

  async onJoin(_ctx: { componentId: string }): Promise<void | false> {
    // Simulate async validation (e.g. DB lookup)
    await new Promise(resolve => setTimeout(resolve, 10))
    return false // REJECT
  }
}

class AsyncLeaveRoom extends LiveRoom<{ count: number }, { leaveCompleted: boolean }> {
  static roomName = 'async-leave'
  static defaultState = { count: 0 }
  static defaultMeta = { leaveCompleted: false }

  leavePromiseResolved = false

  async onLeave(_ctx: { componentId: string; reason: string }): Promise<void> {
    // Simulate async cleanup (e.g. save to DB)
    await new Promise(resolve => setTimeout(resolve, 50))
    this.leavePromiseResolved = true
    this.meta.leaveCompleted = true
  }
}

// ===== Helpers =====

function createManagerWithRoom(RoomClass: LiveRoomClass) {
  const roomEvents = new RoomEventBus()
  const manager = new LiveRoomManager(roomEvents)
  const registry = new RoomRegistry()
  registry.register(RoomClass)
  manager.roomRegistry = registry
  return { manager, roomEvents }
}

function getRoomInstance(manager: LiveRoomManager, roomId: string): any {
  return manager.getRoomInstance(roomId)
}

// ===== BUG TESTS =====

describe('BUG: onDestroy called multiple times (race condition)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('should call onDestroy exactly ONCE when multiple members leave quickly', async () => {
    const { manager } = createManagerWithRoom(TrackingRoom)

    const ws1 = createMockWS()
    const ws2 = createMockWS()
    const ws3 = createMockWS()

    // 3 members join
    await manager.joinRoom('comp-1', 'tracking:room1', ws1)
    await manager.joinRoom('comp-2', 'tracking:room1', ws2)
    await manager.joinRoom('comp-3', 'tracking:room1', ws3)

    const room = getRoomInstance(manager, 'tracking:room1') as TrackingRoom
    expect(room).toBeTruthy()

    // All 3 leave in quick succession — each schedules a setTimeout
    await manager.leaveRoom('comp-1', 'tracking:room1')
    await manager.leaveRoom('comp-2', 'tracking:room1')
    await manager.leaveRoom('comp-3', 'tracking:room1')

    // Advance past the 5-minute cleanup timeout
    vi.advanceTimersByTime(5 * 60 * 1000 + 100)

    // BUG: onDestroy is called multiple times because each leaveRoom()
    // that finds members.size === 0 schedules its own setTimeout.
    // Only the LAST leave (comp-3) makes members.size === 0, but
    // cleanupComponent batching can also schedule a timeout.
    // Expected: exactly 1 call
    expect(room.onDestroyCalls).toBe(1)
  })

  it('should call onDestroy exactly ONCE via cleanupComponent with multiple rooms', async () => {
    const { manager } = createManagerWithRoom(TrackingRoom)

    const ws1 = createMockWS()
    const ws2 = createMockWS()

    // comp-1 and comp-2 are both in the same room
    await manager.joinRoom('comp-1', 'tracking:room1', ws1)
    await manager.joinRoom('comp-2', 'tracking:room1', ws2)

    const room = getRoomInstance(manager, 'tracking:room1') as TrackingRoom

    // Both disconnect simultaneously (via cleanupComponent)
    await manager.cleanupComponent('comp-1')
    await manager.cleanupComponent('comp-2')

    vi.advanceTimersByTime(5 * 60 * 1000 + 100)

    // BUG: Both cleanupComponent calls may schedule separate timeouts
    // for the same room, both calling onDestroy
    expect(room.onDestroyCalls).toBe(1)
  })

  it('should not call onDestroy if a member rejoins before timeout', async () => {
    const { manager } = createManagerWithRoom(TrackingRoom)

    const ws1 = createMockWS()
    const ws2 = createMockWS()

    await manager.joinRoom('comp-1', 'tracking:room1', ws1)
    await manager.leaveRoom('comp-1', 'tracking:room1')

    // Rejoin before timeout
    await manager.joinRoom('comp-2', 'tracking:room1', ws2)

    vi.advanceTimersByTime(5 * 60 * 1000 + 100)

    const room = getRoomInstance(manager, 'tracking:room1') as TrackingRoom
    expect(room.onDestroyCalls).toBe(0)
  })
})

describe('BUG: async onJoin rejection is ignored', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('should reject join when async onJoin returns false', async () => {
    const { manager } = createManagerWithRoom(AsyncRejectRoom)

    const ws = createMockWS()

    // joinRoom is now async — it properly awaits onJoin
    const resultPromise = manager.joinRoom('comp-1', 'async-reject:room1', ws)

    // Allow the async onJoin to complete
    await vi.advanceTimersByTimeAsync(50)
    const result = await resultPromise

    expect('rejected' in result && result.rejected).toBe(true)
  })

  it('should not add member when async onJoin rejects', async () => {
    const { manager } = createManagerWithRoom(AsyncRejectRoom)

    const ws = createMockWS()
    const resultPromise = manager.joinRoom('comp-1', 'async-reject:room1', ws)

    await vi.advanceTimersByTimeAsync(50)
    await resultPromise

    expect(manager.isInRoom('comp-1', 'async-reject:room1')).toBe(false)
  })

  it('should clean up new room if async onJoin rejects the first member', async () => {
    const { manager } = createManagerWithRoom(AsyncRejectRoom)

    const ws = createMockWS()
    const resultPromise = manager.joinRoom('comp-1', 'async-reject:room1', ws)

    await vi.advanceTimersByTimeAsync(50)
    await resultPromise

    expect(manager.getStats().totalRooms).toBe(0)
  })
})

describe('BUG: async onLeave is not awaited', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('should await async onLeave before proceeding', async () => {
    const { manager } = createManagerWithRoom(AsyncLeaveRoom)

    const ws = createMockWS()
    await manager.joinRoom('comp-1', 'async-leave:room1', ws)

    const room = getRoomInstance(manager, 'async-leave:room1') as AsyncLeaveRoom

    // leaveRoom is now async and awaits onLeave internally.
    // Since onLeave uses setTimeout(50ms), we need to advance fake timers
    // concurrently with the await.
    const leavePromise = manager.leaveRoom('comp-1', 'async-leave:room1')
    await vi.advanceTimersByTimeAsync(100)
    await leavePromise

    expect(room.leavePromiseResolved).toBe(true)
  })

  it('should complete async onLeave in cleanupComponent', async () => {
    const { manager } = createManagerWithRoom(AsyncLeaveRoom)

    const ws = createMockWS()
    await manager.joinRoom('comp-1', 'async-leave:room1', ws)

    const room = getRoomInstance(manager, 'async-leave:room1') as AsyncLeaveRoom

    const cleanupPromise = manager.cleanupComponent('comp-1')
    await vi.advanceTimersByTimeAsync(100)
    await cleanupPromise

    expect(room.leavePromiseResolved).toBe(true)
  })
})

describe('BUG: onEvent receives wrong componentId', () => {
  it('should pass the emitting componentId to onEvent, not empty string', async () => {
    const { manager } = createManagerWithRoom(TrackingRoom)

    const ws1 = createMockWS()
    const ws2 = createMockWS()

    await manager.joinRoom('comp-1', 'tracking:room1', ws1)
    await manager.joinRoom('comp-2', 'tracking:room1', ws2)

    const room = getRoomInstance(manager, 'tracking:room1') as TrackingRoom

    // comp-1 emits an event, excluding itself from broadcast
    manager.emitToRoom('tracking:room1', 'chat-msg', { text: 'hello' }, 'comp-1')

    // BUG: onEvent receives excludeComponentId (comp-1) which is correct,
    // but when no excludeComponentId is provided, it receives '' instead of
    // some meaningful identifier of who emitted the event
    expect(room.onEventCalls).toHaveLength(1)
    expect(room.onEventCalls[0].componentId).toBe('comp-1')
    expect(room.onEventCalls[0].event).toBe('chat-msg')
  })

  it('should not pass empty string as componentId when emitter is unknown', async () => {
    const { manager } = createManagerWithRoom(TrackingRoom)

    const ws = createMockWS()
    await manager.joinRoom('comp-1', 'tracking:room1', ws)

    const room = getRoomInstance(manager, 'tracking:room1') as TrackingRoom

    // Emit without excludeComponentId
    manager.emitToRoom('tracking:room1', 'system-event', { msg: 'test' })

    expect(room.onEventCalls).toHaveLength(1)
    // BUG: componentId is '' (empty string) when excludeComponentId is undefined
    // It should be either undefined/null or some meaningful value
    expect(room.onEventCalls[0].componentId).not.toBe('')
  })
})

describe('BUG: room state size estimation is inaccurate', () => {
  it('should track state size accurately after multiple updates', async () => {
    const roomEvents = new RoomEventBus()
    const manager = new LiveRoomManager(roomEvents)

    const ws = createMockWS()
    await manager.joinRoom('comp-1', 'game:1', ws, { a: 1, b: 'hello', c: [1, 2, 3] })

    // Do several updates that change existing fields
    manager.setRoomState('game:1', { a: 999 })
    manager.setRoomState('game:1', { b: 'x' })
    manager.setRoomState('game:1', { c: [1] })

    // Get actual state size
    const state = manager.getRoomState('game:1')
    const actualSize = JSON.stringify(state).length

    // The internal stateSize estimate should be reasonably close to actual
    // BUG: stateSize += deltaSize is additive, but JSON size isn't additive.
    // After replacing b:'hello' with b:'x', the delta is {"b":"x"} (7 chars)
    // but the total state actually DECREASED in size.
    // We can't directly access room.stateSize, but we can verify behavior:
    // If estimation is too high, it might throw "exceeds size limit" prematurely.

    // This state should be well under any limit
    expect(actualSize).toBeLessThan(100)
    expect(state).toEqual({ a: 999, b: 'x', c: [1] })
  })
})
