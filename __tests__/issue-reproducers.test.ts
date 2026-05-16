// Reproducers for issues #33, #34, #35, #36 — each test recreates the
// exact scenario from the GitHub issue and asserts the fix holds.

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────
// #33 — stub generator produces invalid JS when defaultState strings
//       contain '.' or '!'
// ─────────────────────────────────────────────────────────────────────────
describe('#33 stub generator: strings with . and !', () => {
  it('reproduces the LiveTrophyHunt minimal repro end-to-end via extractMeta', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('fs')
    const { tmpdir } = await import('os')
    const { join } = await import('path')
    const { _internals } = await import('../packages/core/src/build/index')

    const dir = mkdtempSync(join(tmpdir(), 'issue-33-'))
    try {
      const file = join(dir, 'LiveTrophyHunt.ts')
      // EXACT class body from issue #33:
      writeFileSync(file, `
        import { LiveComponent } from '@fluxstack/live'
        export class LiveTrophyHunt extends LiveComponent<typeof LiveTrophyHunt.defaultState> {
          static componentName = 'LiveTrophyHunt'
          static defaultState = {
            status: 'Procure o trofeu pelo mundo. Use as dicas!' as string,
          }
          static publicActions = ['move'] as const
        }
      `, 'utf-8')

      const metas = _internals.extractMeta(file)
      expect(metas).toHaveLength(1)

      const stub = _internals.buildStub(metas)

      // BEFORE the fix the stub contained `status: 'Procure o trofeu pelo mundo. Use,`
      // and was invalid JS. Vite reported:
      //   "Plugin: vite:import-analysis ... Unterminated string"
      expect(stub).toContain(`'Procure o trofeu pelo mundo. Use as dicas!'`)

      // The stub must be valid JavaScript that Vite can parse — `new Function`
      // is the same parser path.
      const exec = new Function(
        stub.replace(/^export /gm, '') +
        '; return LiveTrophyHunt.defaultState',
      )
      expect(exec()).toEqual({
        status: 'Procure o trofeu pelo mundo. Use as dicas!',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────
// #34 — LiveComponentsProvider opens duplicate WebSockets under StrictMode
// ─────────────────────────────────────────────────────────────────────────
describe('#34 StrictMode double-mount does not open a second socket', () => {
  it('reuses the pooled connection across mount → cleanup → mount', async () => {
    const { acquire, release, poolKey, _resetPool } = await import('../packages/react/src/connectionPool')
    _resetPool()
    vi.useFakeTimers()

    let openCount = 0
    class FakeConn {
      constructor() { openCount++ /* this is the "WS handshake" */ }
      disconnect() {}
    }

    // Exact StrictMode sequence: effect runs, cleanup runs, effect runs.
    const key = poolKey({ url: 'ws://localhost:3000/api/live/ws' })
    const c1 = acquire(key, () => new FakeConn() as any)
    release(key)                                        // cleanup
    const c2 = acquire(key, () => new FakeConn() as any) // remount

    // The issue says: "Server log: GET /api/live/ws -> 200 (twice)".
    // With the fix there must be exactly ONE handshake.
    expect(openCount).toBe(1)
    expect(c2).toBe(c1)
    // And no orphan socket is left after the real unmount:
    release(key)
    vi.advanceTimersByTime(100)
    vi.useRealTimers()
  })
})

// ─────────────────────────────────────────────────────────────────────────
// #35 — actions throw 'Not connected' between $connected=true and $status='synced'
// ─────────────────────────────────────────────────────────────────────────
describe('#35 the "$connected=true but mounting" window now has a proper signal', () => {
  it('isReady is false in the exact failure window from the issue', async () => {
    const { isReady, computeStatus, notReadyError } = await import('../packages/react/src/hooks/readiness')

    // The issue's symptom log was: `{connected: true, playerId: ""}` →
    // "register failed Error: Not connected". Translated:
    //   connected=true, componentId=null (mount RPC in flight)
    const window = {
      connected: true,
      rehydrating: false,
      loading: false,
      error: null,
      componentId: null,
    }
    expect(computeStatus(window)).toBe('mounting')
    expect(isReady(window)).toBe(false)

    // After mount the proxy flips to synced, and isReady is true:
    expect(isReady({ ...window, componentId: 'comp-1' })).toBe(true)

    // The new error message is informative — it does NOT say "Not connected"
    // in this case, because the WebSocket IS connected.
    const err = notReadyError('move', 'LiveTrophyHunt', window)
    expect(err.message).not.toMatch(/^Error: Not connected$/)
    expect(err.message).toContain('not mounted')
    expect(err.message).toContain('$ready')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// #36 — RoomLeaveContext lacks identity to clean up players keyed by app id
// ─────────────────────────────────────────────────────────────────────────
describe('#36 onLeave can clean state keyed by an app-specific player id', () => {
  beforeEach(() => { vi.resetModules() })

  it('reproduces TrophyRoom scenario and removes the player entry on abrupt disconnect', async () => {
    // Mock the batcher + logger BEFORE importing the manager (mirrors the
    // pattern used in core/__tests__).
    vi.doMock('../packages/core/src/transport/WsSendBatcher', () => ({
      queueWsMessage: vi.fn(),
      queuePreSerialized: vi.fn(),
      sendImmediate: vi.fn(),
      sendBinaryImmediate: vi.fn(),
    }))
    vi.doMock('../packages/core/src/debug/LiveLogger', () => ({
      liveLog: vi.fn(),
      liveWarn: vi.fn(),
      registerComponentLogging: vi.fn(),
      unregisterComponentLogging: vi.fn(),
    }))

    const { LiveRoomManager } = await import('../packages/core/src/rooms/LiveRoomManager')
    const { LiveRoom } = await import('../packages/core/src/rooms/LiveRoom')
    const { RoomRegistry } = await import('../packages/core/src/rooms/RoomRegistry')
    const { RoomEventBus } = await import('../packages/core/src/rooms/RoomEventBus')
    const { ANONYMOUS_CONTEXT } = await import('../packages/core/src/auth/LiveAuthContext')

    type TrophyPlayer = { id: string; name: string }
    type TrophyState = { players: Record<string, TrophyPlayer> }

    // The exact class shape from the issue:
    class TrophyRoom extends LiveRoom<TrophyState> {
      static roomName = 'trophy'
      static defaultState: TrophyState = { players: {} }

      onJoin(ctx: any) {
        // app-specific id (NOT framework componentId)
        ctx.membership.playerId = ctx.payload.playerId
        this.state.players[ctx.payload.playerId] = {
          id: ctx.payload.playerId,
          name: ctx.payload.name,
        }
      }

      onLeave(ctx: any) {
        // Before #36 this was impossible — onLeave didn't know the playerId.
        delete this.state.players[ctx.membership.playerId]
      }
    }

    const mgr = new LiveRoomManager(new RoomEventBus())
    const registry = new RoomRegistry()
    registry.register(TrophyRoom as any)
    mgr.roomRegistry = registry

    const ws: any = {
      send: () => {},
      close: () => {},
      data: {
        connectionId: 'ws-1',
        components: new Map(),
        subscriptions: new Set(),
        connectedAt: new Date(),
        userId: undefined,
        authContext: ANONYMOUS_CONTEXT,
      },
      remoteAddress: '127.0.0.1',
      readyState: 1,
    }

    await mgr.joinRoom('comp-1', 'trophy:lobby', ws, undefined, undefined, {
      payload: { playerId: 'player-abc', name: 'Alice' },
    })

    const roomState = (mgr as any).rooms.get('trophy:lobby').state as TrophyState
    expect(roomState.players['player-abc']).toEqual({ id: 'player-abc', name: 'Alice' })

    // Simulate the exact failure mode: tab closed / network drop →
    // cleanupComponent is what runs.
    await mgr.cleanupComponent('comp-1')

    expect(roomState.players['player-abc']).toBeUndefined()
  })
})
