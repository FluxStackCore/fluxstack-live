// Adversarial — race conditions + room state poisoning. Goes beyond
// well-formed lifecycle: simulates clients that disconnect mid-action,
// flood ROOM_EMIT with forged events, claim non-membership operations,
// and run dual-tab interleaving that would catch ordering bugs.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LiveServer } from '../../server/LiveServer'
import { LiveComponent } from '../../component/LiveComponent'
import { LiveRoom } from '../../rooms/LiveRoom'
import { createMockWS, spyOnConsole } from '../helpers'
import type {
  LiveTransport,
  WebSocketConfig,
  HttpRouteDefinition,
  GenericWebSocket,
} from '../../transport/types'

interface Cap {
  transport: LiveTransport
  send: (ws: GenericWebSocket, msg: unknown, isBinary?: boolean) => Promise<void>
}

function captureTransport(): Cap {
  let onMessage: ((ws: GenericWebSocket, m: unknown, isBinary: boolean) => void | Promise<void>) | undefined
  return {
    transport: {
      async registerWebSocket(c: WebSocketConfig) { onMessage = c.onMessage },
      async registerHttpRoutes(_r: HttpRouteDefinition[]) {},
    },
    send: async (ws, m, isBinary = false) => {
      if (!onMessage) throw new Error('not started')
      await onMessage(ws, m, isBinary)
    },
  }
}

class SlowCounter extends LiveComponent<{ count: number }> {
  static componentName = 'SlowCounter'
  static defaultState = { count: 0 }
  static publicActions = ['bumpSlow', 'bump'] as const
  async bumpSlow() {
    await new Promise(r => setTimeout(r, 100))
    this.setState({ count: this.state.count + 1 })
    return { count: this.state.count }
  }
  bump() { this.setState({ count: this.state.count + 1 }); return { count: this.state.count } }
}

class Lobby extends LiveRoom<{ players: Record<string, { name: string }> }> {
  static roomName = 'lobby'
  static defaultState = { players: {} }
  onJoin(ctx: any) {
    if (ctx.payload?.name) {
      ctx.membership.name = ctx.payload.name
      this.state.players[ctx.componentId] = { name: ctx.payload.name }
    }
  }
  onLeave(ctx: any) {
    delete this.state.players[ctx.componentId]
  }
}

async function startServer(opts: Partial<ConstructorParameters<typeof LiveServer>[0]> = {}) {
  const cap = captureTransport()
  const server = new LiveServer({
    transport: cap.transport,
    components: [SlowCounter as any],
    rooms: [Lobby as any],
    rateLimitMaxTokens: 10_000,
    ...opts,
  } as any)
  await server.start()
  return { server, send: cap.send, cap }
}

let consoleSpy: ReturnType<typeof spyOnConsole>
beforeEach(() => { consoleSpy = spyOnConsole() })
afterEach(() => { consoleSpy?.restore() })

// Helper: pluck the JSON message matching a requestId.
function findReply(ws: ReturnType<typeof createMockWS>, reqId: string) {
  const raw = ws._messages.find(m => m.includes(`"requestId":"${reqId}"`))
  return raw ? JSON.parse(raw) : undefined
}

// ─────────────────────────────────────────────────────────────────────────
// Disconnect mid-action
// ─────────────────────────────────────────────────────────────────────────

describe('races: disconnect during async action', () => {
  it('client disconnects while an async action is in flight — server does not crash', async () => {
    const { server, send } = await startServer()
    const ws = createMockWS()

    await send(ws, '{"type":"COMPONENT_MOUNT","componentId":"c-1","payload":{"component":"SlowCounter"},"requestId":"r0"}')
    const cid = findReply(ws, 'r0').result.componentId

    // Fire the slow action, do NOT await it yet
    const inflight = send(ws, `{"type":"CALL_ACTION","componentId":"${cid}","action":"bumpSlow","requestId":"r1","expectResponse":true}`)

    // Immediately simulate the client closing — registry cleanup runs.
    server.registry.cleanupConnection(ws)

    // Action must still settle (resolve OR reject) without crashing the process.
    await expect(inflight).resolves.not.toThrow()
  })

  it('100 concurrent slow actions then disconnect mid-flight — no orphan promises', async () => {
    const { server, send } = await startServer()
    const ws = createMockWS()
    await send(ws, '{"type":"COMPONENT_MOUNT","componentId":"c-1","payload":{"component":"SlowCounter"},"requestId":"r0"}')
    const cid = findReply(ws, 'r0').result.componentId

    const inflight: Promise<void>[] = []
    for (let i = 0; i < 100; i++) {
      inflight.push(send(ws, `{"type":"CALL_ACTION","componentId":"${cid}","action":"bumpSlow","requestId":"a${i}","expectResponse":true}`))
    }

    // Disconnect halfway through; let the rest settle.
    await new Promise(r => setTimeout(r, 50))
    server.registry.cleanupConnection(ws)

    const results = await Promise.allSettled(inflight)
    // All must settle (fulfilled or rejected), none hang.
    expect(results).toHaveLength(100)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Reconnect storm
// ─────────────────────────────────────────────────────────────────────────

describe('races: reconnect storm', () => {
  it('100 sequential mount/unmount cycles do not leak components', async () => {
    const { server, send } = await startServer()
    const ws = createMockWS()
    for (let i = 0; i < 100; i++) {
      await send(ws, `{"type":"COMPONENT_MOUNT","componentId":"x","payload":{"component":"SlowCounter"},"requestId":"m${i}"}`)
      const cid = findReply(ws, `m${i}`)?.result?.componentId
      if (cid) {
        await send(ws, `{"type":"COMPONENT_UNMOUNT","componentId":"${cid}","requestId":"u${i}"}`)
      }
    }
    const stats = server.registry.getStats()
    // After symmetric mount/unmount, no components should remain.
    expect(stats.components).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Room state poisoning
// ─────────────────────────────────────────────────────────────────────────

describe('rooms: forged emit / leave / state operations', () => {
  it('client cannot ROOM_EMIT to a room it has not joined', async () => {
    const { send } = await startServer()
    const wsA = createMockWS({ connectionId: 'A' })
    await send(wsA, '{"type":"COMPONENT_MOUNT","componentId":"c-1","payload":{"component":"SlowCounter"},"requestId":"r0"}')
    const cid = findReply(wsA, 'r0').result.componentId

    // Try to emit into lobby:main without joining first.
    await send(wsA, `{"type":"ROOM_EMIT","componentId":"${cid}","roomId":"lobby:main","payload":{"event":"hello","data":{}},"requestId":"r1"}`)
    const errFrame = wsA._messages.find(m => m.includes('"requestId":"r1"') || m.includes('Not a member'))
    expect(errFrame).toBeDefined()
    expect(errFrame).toMatch(/Not a member/i)
  })

  it('client cannot ROOM_STATE_SET on a room it has not joined', async () => {
    const { send } = await startServer()
    const wsA = createMockWS({ connectionId: 'A' })
    await send(wsA, '{"type":"COMPONENT_MOUNT","componentId":"c-1","payload":{"component":"SlowCounter"},"requestId":"r0"}')
    const cid = findReply(wsA, 'r0').result.componentId

    await send(wsA, `{"type":"ROOM_STATE_SET","componentId":"${cid}","roomId":"lobby:main","payload":{"state":{"injected":"yes"}},"requestId":"r1"}`)
    const errFrame = wsA._messages.find(m => m.includes('Not a member'))
    expect(errFrame).toBeDefined()
  })

  it('ROOM_STATE_SET with $-prefix or __proto__ keys is filtered (joined member)', async () => {
    const { server, send } = await startServer()
    const wsA = createMockWS({ connectionId: 'A' })
    await send(wsA, '{"type":"COMPONENT_MOUNT","componentId":"c-1","payload":{"component":"SlowCounter"},"requestId":"r0"}')
    const cid = findReply(wsA, 'r0').result.componentId

    // Join an open (non-typed) room so serverOnlyState is false.
    await send(wsA, `{"type":"ROOM_JOIN","componentId":"${cid}","roomId":"open:r1","requestId":"r1"}`)

    // Attempt forbidden keys + a legitimate one.
    await send(wsA, `{"type":"ROOM_STATE_SET","componentId":"${cid}","roomId":"open:r1","payload":{"state":{"count":1,"$leak":"x","__proto__":{"hacked":true}}},"requestId":"r2"}`)

    // Read back via internal access:
    const room = (server as any).roomManager.rooms.get('open:r1')
    expect(room?.state?.count).toBe(1)
    expect(room?.state?.$leak).toBeUndefined()
    expect((room?.state as any)?.__proto__).toEqual(Object.prototype)
    expect(({} as any).hacked).toBeUndefined()
  })

  it('typed LiveRoom rejects client ROOM_STATE_SET entirely (serverOnlyState)', async () => {
    const { server, send } = await startServer()
    const wsA = createMockWS({ connectionId: 'A' })
    await send(wsA, '{"type":"COMPONENT_MOUNT","componentId":"c-1","payload":{"component":"SlowCounter"},"requestId":"r0"}')
    const cid = findReply(wsA, 'r0').result.componentId

    // Pre-join via manager so the typed room exists with serverOnlyState=true
    const mgr = (server as any).roomManager
    await mgr.joinRoom(cid, 'lobby:main', wsA, undefined, undefined, { payload: { name: 'Alice' } })

    // Now the WS-level ROOM_STATE_SET handler must reject because serverOnlyState=true.
    await send(wsA, `{"type":"ROOM_STATE_SET","componentId":"${cid}","roomId":"lobby:main","payload":{"state":{"players":{}}},"requestId":"r2"}`)

    const err = wsA._messages.find(m => m.includes('server-only'))
    expect(err).toBeDefined()
  })

  it('ROOM_LEAVE for a room never joined is a no-op (no crash)', async () => {
    const { send } = await startServer()
    const wsA = createMockWS({ connectionId: 'A' })
    await send(wsA, '{"type":"COMPONENT_MOUNT","componentId":"c-1","payload":{"component":"SlowCounter"},"requestId":"r0"}')
    const cid = findReply(wsA, 'r0').result.componentId

    await expect(
      send(wsA, `{"type":"ROOM_LEAVE","componentId":"${cid}","roomId":"never-joined:x","requestId":"r1"}`)
    ).resolves.not.toThrow()
  })

  it('flood: 500 ROOM_EMITs in burst rate-limit kicks in', async () => {
    const { send } = await startServer({ rateLimitMaxTokens: 50, rateLimitRefillRate: 5 } as any)
    const wsA = createMockWS({ connectionId: 'A' })
    await send(wsA, '{"type":"COMPONENT_MOUNT","componentId":"c-1","payload":{"component":"SlowCounter"},"requestId":"r0"}')
    const cid = findReply(wsA, 'r0').result.componentId
    await send(wsA, `{"type":"ROOM_JOIN","componentId":"${cid}","roomId":"open:flood","requestId":"r1"}`)

    for (let i = 0; i < 500; i++) {
      await send(wsA, `{"type":"ROOM_EMIT","componentId":"${cid}","roomId":"open:flood","payload":{"event":"x","data":{}}}`)
    }

    const rateLimitedCount = wsA._messages.filter(m => m.includes('Rate limit exceeded')).length
    expect(rateLimitedCount).toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Multi-client interleaving (no shared state corruption)
// ─────────────────────────────────────────────────────────────────────────

describe('rooms: multi-client interleaving', () => {
  it('two clients joining and acting in the same room have independent membership', async () => {
    const { server, send } = await startServer()
    const wsA = createMockWS({ connectionId: 'A' })
    const wsB = createMockWS({ connectionId: 'B' })

    await send(wsA, '{"type":"COMPONENT_MOUNT","componentId":"c-A","payload":{"component":"SlowCounter"},"requestId":"a0"}')
    const cidA = findReply(wsA, 'a0').result.componentId
    await send(wsB, '{"type":"COMPONENT_MOUNT","componentId":"c-B","payload":{"component":"SlowCounter"},"requestId":"b0"}')
    const cidB = findReply(wsB, 'b0').result.componentId

    // Join via the room manager directly with the LiveRoom payload — bypasses
    // the WS framing differences so we exercise just the room semantics.
    const mgr = (server as any).roomManager
    await mgr.joinRoom(cidA, 'lobby:main', wsA, undefined, undefined, { payload: { name: 'Alice' } })
    await mgr.joinRoom(cidB, 'lobby:main', wsB, undefined, undefined, { payload: { name: 'Bob' } })

    const room = mgr.rooms.get('lobby:main')
    expect(room).toBeDefined()
    expect(Object.values(room.state.players).map((p: any) => p.name).sort()).toEqual(['Alice', 'Bob'])

    // A disconnects abruptly. B's entry must survive.
    server.registry.cleanupConnection(wsA)
    await mgr.cleanupComponent(cidA)
    await new Promise(r => setTimeout(r, 50))

    const remaining = Object.values(room.state.players).map((p: any) => p.name)
    expect(remaining).toEqual(['Bob'])
  })

  it('A cannot leak B\'s membership data via onLeave (independence)', async () => {
    const { server, send } = await startServer()
    const wsA = createMockWS({ connectionId: 'A' })
    const wsB = createMockWS({ connectionId: 'B' })

    await send(wsA, '{"type":"COMPONENT_MOUNT","componentId":"c-A","payload":{"component":"SlowCounter"},"requestId":"a0"}')
    const cidA = findReply(wsA, 'a0').result.componentId
    await send(wsB, '{"type":"COMPONENT_MOUNT","componentId":"c-B","payload":{"component":"SlowCounter"},"requestId":"b0"}')
    const cidB = findReply(wsB, 'b0').result.componentId

    const mgr = (server as any).roomManager
    await mgr.joinRoom(cidA, 'lobby:main', wsA, undefined, undefined, { payload: { name: 'Alice' } })
    await mgr.joinRoom(cidB, 'lobby:main', wsB, undefined, undefined, { payload: { name: 'Bob' } })

    const roomBefore = mgr.rooms.get('lobby:main')
    const memberA = roomBefore.members.get(cidA)
    const memberB = roomBefore.members.get(cidB)
    expect(memberA.membership.name).toBe('Alice')
    expect(memberB.membership.name).toBe('Bob')

    // Mutating A's membership must not affect B.
    memberA.membership.name = 'MUTATED'
    expect(memberB.membership.name).toBe('Bob')
  })
})
