// RoomJoinContext.session / RoomLeaveContext.session — full auth session
// reaches the lifecycle hooks, not just the id. Confirms the API is generic
// (works for user/bot/device sessions defined by the provider).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LiveRoomManager } from '../../rooms/LiveRoomManager'
import { LiveRoom } from '../../rooms/LiveRoom'
import { RoomRegistry } from '../../rooms/RoomRegistry'
import { RoomEventBus } from '../../rooms/RoomEventBus'
import type { GenericWebSocket, LiveWSData } from '../../transport/types'
import { ANONYMOUS_CONTEXT } from '../../auth/LiveAuthContext'
import type { LiveAuthContext, LiveAuthSession } from '../../auth/types'

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

function authCtxFor(session: LiveAuthSession): LiveAuthContext {
  return {
    authenticated: true,
    session,
    authenticatedAt: Date.now(),
    hasRole: (r) => session.roles?.includes(r) ?? false,
    hasAnyRole: (rs) => rs.some(r => session.roles?.includes(r) ?? false),
    hasAllRoles: (rs) => rs.every(r => session.roles?.includes(r) ?? false),
    hasPermission: (p) => session.permissions?.includes(p) ?? false,
    hasAllPermissions: (ps) => ps.every(p => session.permissions?.includes(p) ?? false),
    hasAnyPermission: (ps) => ps.some(p => session.permissions?.includes(p) ?? false),
  }
}

function wsWithAuth(authContext: LiveAuthContext): GenericWebSocket {
  const data: LiveWSData = {
    connectionId: `ws-${Math.random().toString(36).slice(2, 10)}`,
    components: new Map(),
    subscriptions: new Set(),
    connectedAt: new Date(),
    userId: authContext.authenticated ? authContext.session?.id : undefined,
    authContext,
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

describe('RoomJoinContext.session — generic auth payload', () => {
  it('auto-derives session from ws.data.authContext when joinContext omits it', async () => {
    const { mgr, registry } = makeManager()
    let captured: any = null

    class R extends LiveRoom<{ ok: boolean }> {
      static roomName = 'auto'
      static defaultState = { ok: true }
      onJoin(ctx: any) { captured = ctx.session }
    }
    registry.register(R as any)

    const ws = wsWithAuth(authCtxFor({ id: 'usr-1', email: 'a@b.com', plan: 'pro' }))
    await mgr.joinRoom('c-1', 'auto:r', ws) // no joinContext at all

    expect(captured).toMatchObject({ id: 'usr-1', email: 'a@b.com', plan: 'pro' })
  })

  it('exposes the full session shape — not just the id — for bot providers', async () => {
    const { mgr, registry } = makeManager()
    let captured: any = null

    class BotRoom extends LiveRoom<{ active: string[] }> {
      static roomName = 'bot'
      static defaultState = { active: [] as string[] }
      onJoin(ctx: any) { captured = ctx.session }
    }
    registry.register(BotRoom as any)

    const ws = wsWithAuth(authCtxFor({
      id: 'bot-42',
      kind: 'bot',
      model: 'gpt-4',
      allowedActions: ['summarize', 'reply'],
    }))
    await mgr.joinRoom('c-1', 'bot:room', ws)

    expect(captured).toEqual({
      id: 'bot-42',
      kind: 'bot',
      model: 'gpt-4',
      allowedActions: ['summarize', 'reply'],
    })
  })

  it('exposes the full session shape for IoT device providers', async () => {
    const { mgr, registry } = makeManager()
    let captured: any = null

    class DeviceRoom extends LiveRoom<{ devices: any[] }> {
      static roomName = 'iot'
      static defaultState = { devices: [] as any[] }
      onJoin(ctx: any) { captured = ctx.session }
    }
    registry.register(DeviceRoom as any)

    const ws = wsWithAuth(authCtxFor({
      id: 'dev-xyz',
      deviceType: 'sensor',
      location: 'sala-2',
      firmware: '1.4.0',
    }))
    await mgr.joinRoom('c-1', 'iot:room', ws)

    expect(captured.deviceType).toBe('sensor')
    expect(captured.location).toBe('sala-2')
    expect(captured.firmware).toBe('1.4.0')
  })

  it('joinContext.session takes precedence over ws.data.authContext.session', async () => {
    const { mgr, registry } = makeManager()
    let captured: any = null

    class R extends LiveRoom<{ x: number }> {
      static roomName = 'override'
      static defaultState = { x: 0 }
      onJoin(ctx: any) { captured = ctx.session }
    }
    registry.register(R as any)

    const ws = wsWithAuth(authCtxFor({ id: 'from-ws', kind: 'auto' }))
    await mgr.joinRoom('c-1', 'override:r', ws, undefined, undefined, {
      session: { id: 'from-caller', kind: 'manual' } as LiveAuthSession,
    })

    expect(captured).toEqual({ id: 'from-caller', kind: 'manual' })
  })

  it('session is undefined for anonymous ws (no auth context)', async () => {
    const { mgr, registry } = makeManager()
    let captured: any = '__SENTINEL__'

    class R extends LiveRoom<{ x: number }> {
      static roomName = 'anon-r'
      static defaultState = { x: 0 }
      onJoin(ctx: any) { captured = ctx.session }
    }
    registry.register(R as any)

    const ws = wsWithAuth(ANONYMOUS_CONTEXT)
    await mgr.joinRoom('c-1', 'anon-r:room', ws)

    expect(captured).toBeUndefined()
  })

  it('deprecated userId is still populated from session.id', async () => {
    const { mgr, registry } = makeManager()
    let captured: any = null

    class R extends LiveRoom<{ x: number }> {
      static roomName = 'dep'
      static defaultState = { x: 0 }
      onJoin(ctx: any) { captured = { userId: ctx.userId, sessionId: ctx.session?.id } }
    }
    registry.register(R as any)

    const ws = wsWithAuth(authCtxFor({ id: 'usr-99', kind: 'user' }))
    await mgr.joinRoom('c-1', 'dep:r', ws)

    expect(captured.userId).toBe('usr-99')
    expect(captured.sessionId).toBe('usr-99')
  })
})

describe('RoomLeaveContext.session — survives to onLeave', () => {
  it('session captured at onJoin is delivered intact to onLeave on explicit leave', async () => {
    const { mgr, registry } = makeManager()
    let leaveCtx: any = null

    class R extends LiveRoom<{ x: number }> {
      static roomName = 'sl'
      static defaultState = { x: 0 }
      onLeave(ctx: any) { leaveCtx = ctx }
    }
    registry.register(R as any)

    const ws = wsWithAuth(authCtxFor({
      id: 'bot-1',
      kind: 'bot',
      model: 'claude-3',
    }))
    await mgr.joinRoom('c-1', 'sl:r', ws)
    await mgr.leaveRoom('c-1', 'sl:r', 'leave')

    expect(leaveCtx.session).toEqual({ id: 'bot-1', kind: 'bot', model: 'claude-3' })
    expect(leaveCtx.userId).toBe('bot-1') // deprecated alias still works
  })

  it('session survives abrupt disconnect (cleanupComponent path)', async () => {
    const { mgr, registry } = makeManager()
    let leaveCtx: any = null

    class R extends LiveRoom<{ x: number }> {
      static roomName = 'sl2'
      static defaultState = { x: 0 }
      onLeave(ctx: any) { leaveCtx = ctx }
    }
    registry.register(R as any)

    const ws = wsWithAuth(authCtxFor({ id: 'dev-1', deviceType: 'sensor' }))
    await mgr.joinRoom('c-1', 'sl2:r', ws)
    await mgr.cleanupComponent('c-1')

    expect(leaveCtx.session).toEqual({ id: 'dev-1', deviceType: 'sensor' })
    expect(leaveCtx.reason).toBe('disconnect')
  })

  it('onLeave can read arbitrary session fields without consulting membership', async () => {
    // The whole point: dev no longer needs to copy session fields into
    // ctx.membership at onJoin just to get them back at onLeave.
    const { mgr, registry } = makeManager()
    const cleanupLog: any[] = []

    class R extends LiveRoom<{ x: number }> {
      static roomName = 'direct'
      static defaultState = { x: 0 }
      onLeave(ctx: any) {
        if (ctx.session?.kind === 'bot') {
          cleanupLog.push({ id: ctx.session.id, model: ctx.session.model })
        }
      }
    }
    registry.register(R as any)

    await mgr.joinRoom('c-a', 'direct:r',
      wsWithAuth(authCtxFor({ id: 'b-1', kind: 'bot', model: 'gpt-4' })))
    await mgr.joinRoom('c-b', 'direct:r',
      wsWithAuth(authCtxFor({ id: 'u-1', kind: 'user' }))) // not a bot

    await mgr.cleanupComponent('c-a')
    await mgr.cleanupComponent('c-b')

    expect(cleanupLog).toEqual([{ id: 'b-1', model: 'gpt-4' }])
  })
})
