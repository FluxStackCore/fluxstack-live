// Regression tests for issue #15: asymmetry between LiveRoom.emit() and
// the ComponentRoomProxy $room().emit() path.
//
// Summary of the bug:
//   - `this.emit(event, data)` from inside a LiveRoom subclass method does
//     NOT pass any excludeComponentId to LiveRoomManager.emitToRoom, so all
//     room.on subscribers receive the event.
//   - `this.$room(X, id).emit(event, data)` from a LiveComponent DOES pass
//     `self.componentId` as excludeComponentId, silently dropping the event
//     for the caller's own `room.on` handlers.
//
// Fix (Option B from the issue): add an options parameter to the proxy
// emit — `emit(event, data, { includeSelf: true })` — that opts out of the
// self-exclusion. Default stays exclude-self for backward compatibility.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LiveRoomManager } from '../../rooms/LiveRoomManager'
import { LiveRoom } from '../../rooms/LiveRoom'
import { RoomRegistry } from '../../rooms/RoomRegistry'
import { RoomEventBus } from '../../rooms/RoomEventBus'
import { LiveComponent } from '../../component/LiveComponent'
import { setLiveComponentContext } from '../../component/context'
import { createMockWS } from '../helpers'

// Silence the batcher / logger side-effects so we can focus on the event
// delivery path, not the websocket framing.
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

// ===== Shared fixture =====

type ChatEvents = { 'message:new': { from: string; text: string } }

class ChatRoom extends LiveRoom<{ count: number }, {}, ChatEvents> {
  static roomName = 'issue15-chat'
  static defaultState = { count: 0 }

  // Public method that calls this.emit from inside the room class — this
  // is the path that already works (include-self) and we use it as the
  // baseline for what the proxy should be able to do too.
  broadcastFromRoom(msg: ChatEvents['message:new']): number {
    return this.emit('message:new', msg)
  }
}

function setupManager() {
  const roomEvents = new RoomEventBus()
  const manager = new LiveRoomManager(roomEvents)
  const registry = new RoomRegistry()
  registry.register(ChatRoom as any)
  manager.roomRegistry = registry
  // ComponentRoomProxy reads ctx.roomManager / ctx.roomEvents from the
  // global component context. Install a minimal one for this test.
  setLiveComponentContext({ roomEvents, roomManager: manager })
  return { manager, roomEvents }
}

// ===========================================================================
// Baseline: LiveRoom.emit from inside a room method delivers to every
// subscriber, including components that registered their own handler. This
// is the behaviour the proxy should also be able to produce.
// ===========================================================================
describe('baseline: LiveRoom.emit delivers to the invoking component', () => {
  let cleanup: (() => Promise<void>) | null = null
  afterEach(async () => {
    if (cleanup) { await cleanup(); cleanup = null }
  })

  it('a component that called a room method receives its own emit via room.on', async () => {
    const { manager } = setupManager()

    class Chat extends LiveComponent<{ received: number }> {
      static componentName = 'Issue15BaselineChat'
      static publicActions = [] as const
      static defaultState = { received: 0 }
    }

    const ws = createMockWS()
    const comp = new Chat({}, ws as any)

    // Subscribe to the typed room's 'message:new' via the proxy — this
    // stores the subscription keyed by the component's id.
    const handler = vi.fn()
    const roomHandle = comp.$room(ChatRoom as any, 'r1') as any
    await roomHandle.join()
    roomHandle.on('message:new', handler)

    // Grab the underlying LiveRoom instance and emit via the CLASS method.
    // The class path does not pass excludeComponentId, so the caller's own
    // subscription MUST be invoked.
    const roomInstance = manager.getRoomInstance?.('issue15-chat:r1') as ChatRoom
    expect(roomInstance).toBeTruthy()
    const notified = roomInstance.broadcastFromRoom({ from: 'server', text: 'hi' })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({ from: 'server', text: 'hi' })
    expect(notified).toBeGreaterThanOrEqual(1)

    cleanup = async () => { await manager.cleanupComponent((comp as any).id) }
  })
})

// ===========================================================================
// The bug: proxy emit default — self-exclusion is preserved.
// This test locks down the CURRENT behaviour as the default after the fix
// so the Option B rollout stays backward compatible.
// ===========================================================================
describe('default proxy emit still excludes the caller (backward compat)', () => {
  let cleanup: (() => Promise<void>) | null = null
  afterEach(async () => {
    if (cleanup) { await cleanup(); cleanup = null }
  })

  it('this.$room(X, id).emit(event, data) does not fire the caller own room.on', async () => {
    const { manager } = setupManager()

    class Chat extends LiveComponent<{ received: number }> {
      static componentName = 'Issue15DefaultChat'
      static publicActions = [] as const
      static defaultState = { received: 0 }
    }

    const ws = createMockWS()
    const comp = new Chat({}, ws as any)

    const handler = vi.fn()
    const room = comp.$room(ChatRoom as any, 'r2') as any
    await room.join()
    room.on('message:new', handler)

    // Default proxy emit — should exclude self (documented existing behaviour).
    room.emit('message:new', { from: 'self', text: 'hey' })

    expect(handler).not.toHaveBeenCalled()

    cleanup = async () => { await manager.cleanupComponent((comp as any).id) }
  })

  it('a second component in the same room still receives the default emit', async () => {
    const { manager } = setupManager()

    class ChatA extends LiveComponent<{}> {
      static componentName = 'Issue15DefaultChatA'
      static publicActions = [] as const
      static defaultState = {}
    }
    class ChatB extends LiveComponent<{}> {
      static componentName = 'Issue15DefaultChatB'
      static publicActions = [] as const
      static defaultState = {}
    }

    const wsA = createMockWS()
    const wsB = createMockWS()
    const a = new ChatA({}, wsA as any)
    const b = new ChatB({}, wsB as any)

    const handlerA = vi.fn()
    const handlerB = vi.fn()
    const roomA = a.$room(ChatRoom as any, 'r3') as any
    const roomB = b.$room(ChatRoom as any, 'r3') as any
    await roomA.join()
    await roomB.join()
    roomA.on('message:new', handlerA)
    roomB.on('message:new', handlerB)

    roomA.emit('message:new', { from: 'A', text: 'hi' })

    // Sender excluded, other member receives it.
    expect(handlerA).not.toHaveBeenCalled()
    expect(handlerB).toHaveBeenCalledWith({ from: 'A', text: 'hi' })

    cleanup = async () => {
      await manager.cleanupComponent((a as any).id)
      await manager.cleanupComponent((b as any).id)
    }
  })
})

// ===========================================================================
// fixes #15 — opt-in includeSelf
// ===========================================================================
describe('fixes #15: proxy emit supports { includeSelf: true }', () => {
  let cleanup: (() => Promise<void>) | null = null
  afterEach(async () => {
    if (cleanup) { await cleanup(); cleanup = null }
  })

  it('TYPED proxy: $room(RoomClass, id).emit(event, data, { includeSelf: true }) fires the caller own handler', async () => {
    const { manager } = setupManager()

    class Chat extends LiveComponent<{}> {
      static componentName = 'Issue15TypedIncludeSelf'
      static publicActions = [] as const
      static defaultState = {}
    }

    const ws = createMockWS()
    const comp = new Chat({}, ws as any)

    const handler = vi.fn()
    const room = comp.$room(ChatRoom as any, 'r4') as any
    await room.join()
    room.on('message:new', handler)

    room.emit('message:new', { from: 'self', text: 'echo' }, { includeSelf: true })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({ from: 'self', text: 'echo' })

    cleanup = async () => { await manager.cleanupComponent((comp as any).id) }
  })

  it('UNTYPED proxy: $room("id").emit(event, data, { includeSelf: true }) fires the caller own handler', async () => {
    const { manager } = setupManager()

    class Chat extends LiveComponent<{}> {
      static componentName = 'Issue15UntypedIncludeSelf'
      static publicActions = [] as const
      static defaultState = {}
    }

    const ws = createMockWS()
    const comp = new Chat({}, ws as any)

    // Pre-create a room instance so the untyped handle has a backing room.
    await manager.joinRoom((comp as any).id, 'plain:r5', ws as any, { n: 0 })

    const handler = vi.fn()
    const room = comp.$room('plain:r5')
    ;(room as any).on('custom:event', handler)

    ;(room as any).emit('custom:event', { payload: 1 }, { includeSelf: true })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({ payload: 1 })

    cleanup = async () => { await manager.cleanupComponent((comp as any).id) }
  })

  it('{ includeSelf: false } matches the default (explicit opt-out)', async () => {
    const { manager } = setupManager()

    class Chat extends LiveComponent<{}> {
      static componentName = 'Issue15ExplicitOptOut'
      static publicActions = [] as const
      static defaultState = {}
    }

    const ws = createMockWS()
    const comp = new Chat({}, ws as any)

    const handler = vi.fn()
    const room = comp.$room(ChatRoom as any, 'r6') as any
    await room.join()
    room.on('message:new', handler)

    room.emit('message:new', { from: 'self', text: 'mute me' }, { includeSelf: false })

    expect(handler).not.toHaveBeenCalled()

    cleanup = async () => { await manager.cleanupComponent((comp as any).id) }
  })

  it('includeSelf does not break delivery to other members in the room', async () => {
    const { manager } = setupManager()

    class ChatA extends LiveComponent<{}> {
      static componentName = 'Issue15IncludeSelfWithPeers_A'
      static publicActions = [] as const
      static defaultState = {}
    }
    class ChatB extends LiveComponent<{}> {
      static componentName = 'Issue15IncludeSelfWithPeers_B'
      static publicActions = [] as const
      static defaultState = {}
    }

    const wsA = createMockWS()
    const wsB = createMockWS()
    const a = new ChatA({}, wsA as any)
    const b = new ChatB({}, wsB as any)

    const handlerA = vi.fn()
    const handlerB = vi.fn()
    const roomA = a.$room(ChatRoom as any, 'r7') as any
    const roomB = b.$room(ChatRoom as any, 'r7') as any
    await roomA.join()
    await roomB.join()
    roomA.on('message:new', handlerA)
    roomB.on('message:new', handlerB)

    roomA.emit('message:new', { from: 'A', text: 'broadcast' }, { includeSelf: true })

    expect(handlerA).toHaveBeenCalledWith({ from: 'A', text: 'broadcast' })
    expect(handlerB).toHaveBeenCalledWith({ from: 'A', text: 'broadcast' })

    cleanup = async () => {
      await manager.cleanupComponent((a as any).id)
      await manager.cleanupComponent((b as any).id)
    }
  })
})
