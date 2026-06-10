// End-to-end validation that a developer can define ARBITRARY session shapes
// (user, bot, IoT device) and have those shapes flow intact through:
//   1. their own LiveAuthProvider
//   2. AuthenticatedContext (frozen, generic)
//   3. LiveComponent.this.$auth.session (reads custom fields)
//   4. LiveRoom.onJoin/onLeave ctx.session (ditto, even on abrupt disconnect)
//
// This is the integration counterpart to the unit tests in
// LiveRoomManager.session-context.test.ts — it exercises the real
// LiveAuthManager + AuthenticatedContext, not mocks.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LiveAuthManager } from '../../auth/LiveAuthManager'
import { AuthenticatedContext } from '../../auth/LiveAuthContext'
import { LiveComponent } from '../../component/LiveComponent'
import { LiveRoom } from '../../rooms/LiveRoom'
import { LiveRoomManager } from '../../rooms/LiveRoomManager'
import { RoomRegistry } from '../../rooms/RoomRegistry'
import { RoomEventBus } from '../../rooms/RoomEventBus'
import { createMockWS } from '../helpers'
import type {
  LiveAuthProvider,
  LiveAuthCredentials,
  LiveAuthContext,
  LiveAuthSession,
} from '../../auth/types'

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

// ===== Dev defines custom session shapes =====

interface UserSession extends LiveAuthSession {
  id: string
  email: string
  plan: 'free' | 'pro' | 'enterprise'
  orgId: string
  roles?: string[]
}

interface BotSession extends LiveAuthSession {
  id: string
  kind: 'bot'
  model: string
  ownerOrgId: string
  allowedActions: string[]
}

interface DeviceSession extends LiveAuthSession {
  id: string
  kind: 'device'
  deviceType: 'sensor' | 'actuator'
  location: string
  firmware: string
}

// ===== Dev implements a provider that returns whichever session matches the token =====

class MyMixedProvider implements LiveAuthProvider {
  readonly name = 'mixed'

  async authenticate(creds: LiveAuthCredentials): Promise<LiveAuthContext | null> {
    const token = creds.token as string
    if (!token) return null

    if (token === 'user-token') {
      const s: UserSession = {
        id: 'usr-1', email: 'alice@example.com', plan: 'enterprise',
        orgId: 'org-7', roles: ['admin'],
      }
      return new AuthenticatedContext(s, token)
    }
    if (token === 'bot-token') {
      const s: BotSession = {
        id: 'bot-42', kind: 'bot', model: 'claude-opus-4-7',
        ownerOrgId: 'org-7', allowedActions: ['summarize', 'reply'],
      }
      return new AuthenticatedContext(s, token)
    }
    if (token === 'device-token') {
      const s: DeviceSession = {
        id: 'dev-xyz', kind: 'device', deviceType: 'sensor',
        location: 'sala-2', firmware: '1.4.0',
      }
      return new AuthenticatedContext(s, token)
    }
    return null
  }
}

// ===== Helpers =====

function makeRoomManager() {
  const mgr = new LiveRoomManager(new RoomEventBus())
  const registry = new RoomRegistry()
  mgr.roomRegistry = registry
  return { mgr, registry }
}

let errSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => { errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { errSpy.mockRestore(); vi.clearAllMocks() })

// ─────────────────────────────────────────────────────────────────────────
describe('Provider → AuthenticatedContext → session flows', () => {
  it('LiveAuthManager round-trips a custom UserSession through authenticate()', async () => {
    const authMgr = new LiveAuthManager()
    authMgr.register(new MyMixedProvider())

    const ctx = await authMgr.authenticate({ token: 'user-token' })
    expect(ctx.authenticated).toBe(true)

    const s = ctx.session as UserSession | undefined
    expect(s?.id).toBe('usr-1')
    expect(s?.email).toBe('alice@example.com')
    expect(s?.plan).toBe('enterprise')
    expect(s?.orgId).toBe('org-7')
  })

  it('LiveAuthManager round-trips a custom BotSession (different shape)', async () => {
    const authMgr = new LiveAuthManager()
    authMgr.register(new MyMixedProvider())

    const ctx = await authMgr.authenticate({ token: 'bot-token' })
    const s = ctx.session as BotSession | undefined
    expect(s?.kind).toBe('bot')
    expect(s?.model).toBe('claude-opus-4-7')
    expect(s?.allowedActions).toEqual(['summarize', 'reply'])
  })

  it('LiveAuthManager round-trips a custom DeviceSession (no kind:bot/user)', async () => {
    const authMgr = new LiveAuthManager()
    authMgr.register(new MyMixedProvider())

    const ctx = await authMgr.authenticate({ token: 'device-token' })
    const s = ctx.session as DeviceSession | undefined
    expect(s?.kind).toBe('device')
    expect(s?.deviceType).toBe('sensor')
    expect(s?.location).toBe('sala-2')
    expect(s?.firmware).toBe('1.4.0')
  })

  it('AuthenticatedContext freezes the session — custom fields cannot be mutated', async () => {
    const authMgr = new LiveAuthManager()
    authMgr.register(new MyMixedProvider())

    const ctx = await authMgr.authenticate({ token: 'user-token' })
    const s = ctx.session as UserSession | undefined

    // Mutation must fail silently (frozen) or throw — either is acceptable.
    expect(() => {
      (s as any).plan = 'free' // privilege downgrade attempt
    }).toThrow() // strict mode: TypeError

    // The original value is preserved either way:
    expect((ctx.session as UserSession | undefined)?.plan).toBe('enterprise')
  })

  it('roles/permissions are also frozen (defense against escalation)', async () => {
    const authMgr = new LiveAuthManager()
    authMgr.register(new MyMixedProvider())

    const ctx = await authMgr.authenticate({ token: 'user-token' })
    expect(() => { (ctx.session?.roles as any).push('superadmin') }).toThrow()
    expect(ctx.session?.roles).toEqual(['admin'])
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('Custom session reaches LiveComponent.this.$auth.session', () => {
  it('component receives the full custom session shape', async () => {
    const authMgr = new LiveAuthManager()
    authMgr.register(new MyMixedProvider())
    const ctx = await authMgr.authenticate({ token: 'user-token' })

    // Build a component instance with the auth context (mimics what the
    // framework does during COMPONENT_MOUNT).
    class BillingPanel extends LiveComponent<{ x: number }> {
      static componentName = 'BillingPanel'
      static defaultState = { x: 0 }
      readPlan() {
        const s = this.$auth.session as UserSession | undefined
        return s?.plan
      }
    }
    const comp = new BillingPanel({ x: 0 }, null as any)
    comp.setAuthContext(ctx)

    expect(comp.readPlan()).toBe('enterprise')
    expect((comp.$auth.session as UserSession).email).toBe('alice@example.com')
    expect((comp.$auth.session as UserSession).orgId).toBe('org-7')
  })

  it('component sees a bot session distinctly from a user session', async () => {
    const authMgr = new LiveAuthManager()
    authMgr.register(new MyMixedProvider())

    class GenericComponent extends LiveComponent<{ x: number }> {
      static componentName = 'X'
      static defaultState = { x: 0 }
      whoAmI() {
        const s = this.$auth.session as UserSession | BotSession | undefined
        if (!s) return 'anonymous'
        if ((s as BotSession).kind === 'bot') return `bot:${(s as BotSession).model}`
        return `user:${(s as UserSession).email}`
      }
    }

    const userCtx = await authMgr.authenticate({ token: 'user-token' })
    const botCtx = await authMgr.authenticate({ token: 'bot-token' })

    const c1 = new GenericComponent({ x: 0 }, null as any)
    c1.setAuthContext(userCtx)
    const c2 = new GenericComponent({ x: 0 }, null as any)
    c2.setAuthContext(botCtx)

    expect(c1.whoAmI()).toBe('user:alice@example.com')
    expect(c2.whoAmI()).toBe('bot:claude-opus-4-7')
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('Custom session reaches LiveRoom onJoin / onLeave', () => {
  it('a single GameRoom can dispatch on session.kind across user/bot/device', async () => {
    const authMgr = new LiveAuthManager()
    authMgr.register(new MyMixedProvider())
    const { mgr, registry } = makeRoomManager()

    interface GameState {
      humans: Record<string, { email: string; plan: string }>
      bots: Record<string, { model: string }>
      devices: Record<string, { location: string }>
    }

    class GameRoom extends LiveRoom<GameState> {
      static roomName = 'game'
      static defaultState: GameState = { humans: {}, bots: {}, devices: {} }
      onJoin(ctx: any) {
        const s = ctx.session as UserSession | BotSession | DeviceSession | undefined
        if (!s) return
        if ((s as BotSession).kind === 'bot') {
          this.state.bots[s.id] = { model: (s as BotSession).model }
        } else if ((s as DeviceSession).kind === 'device') {
          this.state.devices[s.id] = { location: (s as DeviceSession).location }
        } else {
          const u = s as UserSession
          this.state.humans[u.id] = { email: u.email, plan: u.plan }
        }
      }
      onLeave(ctx: any) {
        const s = ctx.session as UserSession | BotSession | DeviceSession | undefined
        if (!s) return
        if ((s as BotSession).kind === 'bot') delete this.state.bots[s.id]
        else if ((s as DeviceSession).kind === 'device') delete this.state.devices[s.id]
        else delete this.state.humans[s.id]
      }
    }
    registry.register(GameRoom as any)

    const userCtx = await authMgr.authenticate({ token: 'user-token' })
    const botCtx = await authMgr.authenticate({ token: 'bot-token' })
    const devCtx = await authMgr.authenticate({ token: 'device-token' })

    const wsUser = createMockWS({ authContext: userCtx, userId: userCtx.session?.id })
    const wsBot = createMockWS({ authContext: botCtx, userId: botCtx.session?.id })
    const wsDev = createMockWS({ authContext: devCtx, userId: devCtx.session?.id })

    await mgr.joinRoom('c-user', 'game:r', wsUser)
    await mgr.joinRoom('c-bot', 'game:r', wsBot)
    await mgr.joinRoom('c-dev', 'game:r', wsDev)

    const stateAfterJoin = (mgr as any).rooms.get('game:r').state as GameState
    expect(stateAfterJoin.humans['usr-1']).toEqual({ email: 'alice@example.com', plan: 'enterprise' })
    expect(stateAfterJoin.bots['bot-42']).toEqual({ model: 'claude-opus-4-7' })
    expect(stateAfterJoin.devices['dev-xyz']).toEqual({ location: 'sala-2' })

    // Simulate abrupt disconnect of just the bot.
    await mgr.cleanupComponent('c-bot')

    const stateAfterLeave = (mgr as any).rooms.get('game:r').state as GameState
    expect(stateAfterLeave.bots['bot-42']).toBeUndefined() // bot gone
    expect(stateAfterLeave.humans['usr-1']).toBeDefined()  // user untouched
    expect(stateAfterLeave.devices['dev-xyz']).toBeDefined() // device untouched
  })

  it('session is auto-derived from ws.data.authContext without explicit joinContext', async () => {
    // Caller doesn't pass joinContext at all — the manager pulls session from
    // the websocket's auth context. This is the path real transport adapters
    // (Elysia/Express/Fastify) take.
    const authMgr = new LiveAuthManager()
    authMgr.register(new MyMixedProvider())
    const { mgr, registry } = makeRoomManager()

    let captured: any = null
    class R extends LiveRoom<{ ok: boolean }> {
      static roomName = 'auto-derive'
      static defaultState = { ok: true }
      onJoin(ctx: any) { captured = ctx.session }
    }
    registry.register(R as any)

    const ctx = await authMgr.authenticate({ token: 'bot-token' })
    const ws = createMockWS({ authContext: ctx, userId: ctx.session?.id })

    await mgr.joinRoom('c-1', 'auto-derive:r', ws) // NO joinContext

    expect(captured).toEqual({
      id: 'bot-42',
      kind: 'bot',
      model: 'claude-opus-4-7',
      ownerOrgId: 'org-7',
      allowedActions: ['summarize', 'reply'],
    })
  })

  it('anonymous user (no provider match) → session is undefined throughout', async () => {
    const authMgr = new LiveAuthManager()
    authMgr.register(new MyMixedProvider())
    const { mgr, registry } = makeRoomManager()

    const events: any[] = []
    class R extends LiveRoom<{ x: number }> {
      static roomName = 'anon-flow'
      static defaultState = { x: 0 }
      onJoin(ctx: any) { events.push({ phase: 'join', session: ctx.session, userId: ctx.userId }) }
      onLeave(ctx: any) { events.push({ phase: 'leave', session: ctx.session, userId: ctx.userId }) }
    }
    registry.register(R as any)

    // Wrong token → null → anonymous fallback in real flow
    const ctx = await authMgr.authenticate({ token: 'unknown' })
    expect(ctx.authenticated).toBe(false)

    const ws = createMockWS({ authContext: ctx })
    await mgr.joinRoom('c-1', 'anon-flow:r', ws)
    await mgr.leaveRoom('c-1', 'anon-flow:r')

    expect(events).toEqual([
      { phase: 'join', session: undefined, userId: undefined },
      { phase: 'leave', session: undefined, userId: undefined },
    ])
  })
})
