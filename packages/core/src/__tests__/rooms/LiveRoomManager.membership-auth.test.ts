// Membership × auth interaction (#36). The membership bag must survive the
// presence or absence of auth — and onJoin can stash auth-derived ids in it.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LiveRoomManager } from '../../rooms/LiveRoomManager'
import { LiveRoom } from '../../rooms/LiveRoom'
import { RoomRegistry } from '../../rooms/RoomRegistry'
import { RoomEventBus } from '../../rooms/RoomEventBus'
import type { GenericWebSocket, LiveWSData } from '../../transport/types'
import { ANONYMOUS_CONTEXT } from '../../auth/LiveAuthContext'
import type { LiveAuthContext } from '../../auth/types'

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

function fakeAuthContext(session: { id: string; roles?: string[] }): LiveAuthContext {
  return {
    authenticated: true,
    session,
    authenticatedAt: Date.now(),
    hasRole: (r) => session.roles?.includes(r) ?? false,
    hasAnyRole: (rs) => rs.some(r => session.roles?.includes(r)),
    hasAllRoles: (rs) => rs.every(r => session.roles?.includes(r)),
    hasPermission: () => false,
    hasAllPermissions: () => false,
    hasAnyPermission: () => false,
  }
}

function makeWS(authContext: LiveAuthContext = ANONYMOUS_CONTEXT): GenericWebSocket {
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

describe('membership × auth (#36)', () => {
  it('joinContext.userId is forwarded to onJoin', async () => {
    const { mgr, registry } = makeManager()
    let seen: any = null

    class R extends LiveRoom<{ ok: boolean }> {
      static roomName = 'auth-r'
      static defaultState = { ok: true }
      onJoin(ctx: any) { seen = { userId: ctx.userId, payload: ctx.payload } }
    }
    registry.register(R as any)

    const ws = makeWS(fakeAuthContext({ id: 'user-42', roles: ['user'] }))
    await mgr.joinRoom('c-1', 'auth-r:room', ws, undefined, undefined, {
      userId: 'user-42',
      payload: { extra: 'data' },
    })

    expect(seen).toEqual({ userId: 'user-42', payload: { extra: 'data' } })
  })

  it('userId from auth is preserved in onLeave via membership', async () => {
    const { mgr, registry } = makeManager()
    let leftSeen: any = null

    class TrophyRoom extends LiveRoom<{ players: Record<string, any> }> {
      static roomName = 'trophy'
      static defaultState = { players: {} }
      onJoin(ctx: any) {
        // Stash auth-derived id in membership for later cleanup.
        ctx.membership.userId = ctx.userId
        if (ctx.userId) this.state.players[ctx.userId] = { joinedAt: Date.now() }
      }
      onLeave(ctx: any) {
        leftSeen = { userId: ctx.userId, membership: ctx.membership }
        if (ctx.membership.userId) delete this.state.players[ctx.membership.userId]
      }
    }
    registry.register(TrophyRoom as any)

    await mgr.joinRoom('c-1', 'trophy:lobby', makeWS(), undefined, undefined, {
      userId: 'alice',
    })
    expect((mgr as any).rooms.get('trophy:lobby').state.players.alice).toBeDefined()

    await mgr.cleanupComponent('c-1')

    expect(leftSeen.userId).toBe('alice')
    expect(leftSeen.membership).toEqual({ userId: 'alice' })
    expect((mgr as any).rooms.get('trophy:lobby').state.players.alice).toBeUndefined()
  })

  it('membership works for anonymous users (no userId)', async () => {
    const { mgr, registry } = makeManager()
    let leftSeen: any = null

    class R extends LiveRoom<{ x: number }> {
      static roomName = 'anon'
      static defaultState = { x: 0 }
      onJoin(ctx: any) {
        // No userId — fall back to a guest token in membership.
        ctx.membership.guestToken = `guest-${Math.random().toString(36).slice(2, 8)}`
      }
      onLeave(ctx: any) { leftSeen = ctx }
    }
    registry.register(R as any)

    await mgr.joinRoom('c-1', 'anon:r', makeWS()) // no joinContext at all
    await mgr.leaveRoom('c-1', 'anon:r')

    expect(leftSeen.userId).toBeUndefined()
    expect(leftSeen.membership.guestToken).toMatch(/^guest-/)
  })

  it('two authenticated users in the same room have independent membership', async () => {
    const { mgr, registry } = makeManager()
    const seen: any[] = []

    class R extends LiveRoom<{ x: number }> {
      static roomName = 'multi-auth'
      static defaultState = { x: 0 }
      onJoin(ctx: any) {
        ctx.membership.userId = ctx.userId
        ctx.membership.role = ctx.payload?.role
      }
      onLeave(ctx: any) { seen.push(ctx.membership) }
    }
    registry.register(R as any)

    await mgr.joinRoom('a', 'multi-auth:r', makeWS(fakeAuthContext({ id: 'alice', roles: ['admin'] })), undefined, undefined, {
      userId: 'alice',
      payload: { role: 'admin' },
    })
    await mgr.joinRoom('b', 'multi-auth:r', makeWS(fakeAuthContext({ id: 'bob', roles: ['user'] })), undefined, undefined, {
      userId: 'bob',
      payload: { role: 'user' },
    })

    await mgr.cleanupComponent('a')
    await mgr.cleanupComponent('b')

    expect(seen).toEqual([
      { userId: 'alice', role: 'admin' },
      { userId: 'bob', role: 'user' },
    ])
  })

  it('membership populated from auth roles is recoverable in onLeave', async () => {
    const { mgr, registry } = makeManager()
    const audits: any[] = []

    class AdminRoom extends LiveRoom<{ active: string[] }> {
      static roomName = 'admin'
      static defaultState = { active: [] as string[] }
      onJoin(ctx: any) {
        // In real code this would come from ws.data.authContext.session.roles.
        // We pass it through joinContext.payload to keep the test self-contained.
        ctx.membership.roles = ctx.payload.roles
        ctx.membership.userId = ctx.userId
      }
      onLeave(ctx: any) {
        audits.push({
          userId: ctx.membership.userId,
          wasAdmin: ctx.membership.roles?.includes('admin'),
          reason: ctx.reason,
        })
      }
    }
    registry.register(AdminRoom as any)

    await mgr.joinRoom('c-1', 'admin:panel', makeWS(), undefined, undefined, {
      userId: 'root',
      payload: { roles: ['admin', 'user'] },
    })
    await mgr.cleanupComponent('c-1') // simulate tab close

    expect(audits).toEqual([
      { userId: 'root', wasAdmin: true, reason: 'disconnect' },
    ])
  })
})
