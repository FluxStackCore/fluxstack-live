// Defense against the same injection vector as PROPERTY_UPDATE, but on
// the room-state path: ROOM_STATE_SET → setRoomState used to accept any
// keys from the client, including `$`-prefixed (server-only convention)
// and prototype-pollution keys.
//
// Fix: ROOM_STATE_SET now goes through setRoomStateFromClient which
// strips `__proto__`, `constructor`, `prototype`, and `$`-prefixed keys.
// The plain setRoomState path is preserved for server-internal callers
// (they keep full authority over the state shape).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LiveRoomManager } from '../../rooms/LiveRoomManager'
import { RoomEventBus } from '../../rooms/RoomEventBus'
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

function makeMgr() {
  return new LiveRoomManager(new RoomEventBus())
}

let errSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => { errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { errSpy.mockRestore(); vi.clearAllMocks() })

describe('setRoomStateFromClient — room-state injection defense', () => {
  it('allows normal keys through unchanged', async () => {
    const mgr = makeMgr()
    const ws = createMockWS()
    await mgr.joinRoom('c-1', 'lobby:r', ws, { count: 0, label: 'init' } as any)

    mgr.setRoomStateFromClient('lobby:r', { count: 5, label: 'updated' }, 'c-1')

    const state = (mgr as any).rooms.get('lobby:r').state
    expect(state.count).toBe(5)
    expect(state.label).toBe('updated')
  })

  it('STRIPS $-prefixed keys from client payload', async () => {
    const mgr = makeMgr()
    const ws = createMockWS()
    await mgr.joinRoom('c-1', 'lobby:r', ws, { count: 0 } as any)

    // 🎯 Attack: try to inject `$serverSecret` and `$auth`.
    mgr.setRoomStateFromClient(
      'lobby:r',
      { count: 1, $serverSecret: 'leak', $auth: { roles: ['admin'] } },
      'c-1',
    )

    const state = (mgr as any).rooms.get('lobby:r').state
    expect(state.count).toBe(1)
    expect(state.$serverSecret).toBeUndefined()
    expect(state.$auth).toBeUndefined()
  })

  it('STRIPS prototype-pollution keys from client payload', async () => {
    const mgr = makeMgr()
    const ws = createMockWS()
    await mgr.joinRoom('c-1', 'lobby:r', ws, { count: 0 } as any)

    mgr.setRoomStateFromClient(
      'lobby:r',
      { count: 1, __proto__: { polluted: true }, constructor: 'evil', prototype: 'evil' } as any,
      'c-1',
    )

    const state = (mgr as any).rooms.get('lobby:r').state
    expect(state.count).toBe(1)
    expect((state as any).__proto__).toEqual(Object.prototype) // still default proto
    expect(state.constructor).toBe(Object) // unchanged
    expect((state as any).prototype).toBeUndefined()
    expect(({} as any).polluted).toBeUndefined() // Object.prototype intact
  })

  it('mixes safe and unsafe keys — safe survive, unsafe are dropped', async () => {
    const mgr = makeMgr()
    const ws = createMockWS()
    await mgr.joinRoom('c-1', 'lobby:r', ws, { } as any)

    mgr.setRoomStateFromClient('lobby:r', {
      players: { p1: 'Alice' },
      score: 100,
      $internal: 'hidden',
      __proto__: { x: 1 } as any,
    }, 'c-1')

    const state = (mgr as any).rooms.get('lobby:r').state
    expect(state.players).toEqual({ p1: 'Alice' })
    expect(state.score).toBe(100)
    expect(state.$internal).toBeUndefined()
  })

  it('original setRoomState (server-side path) is NOT filtered', async () => {
    // Server-side code (e.g. LiveRoom subclass setting state via this.state)
    // must keep full authority — the filter is client-only.
    const mgr = makeMgr()
    const ws = createMockWS()
    await mgr.joinRoom('c-1', 'lobby:r', ws, { count: 0 } as any)

    mgr.setRoomState('lobby:r', { count: 1, $serverField: 'allowed' })

    const state = (mgr as any).rooms.get('lobby:r').state
    expect(state.count).toBe(1)
    expect(state.$serverField).toBe('allowed') // server may use $-keys freely
  })

  it('null / non-object payload from client is treated as empty', async () => {
    const mgr = makeMgr()
    const ws = createMockWS()
    await mgr.joinRoom('c-1', 'lobby:r', ws, { count: 0 } as any)

    // Should not throw; state untouched.
    expect(() => mgr.setRoomStateFromClient('lobby:r', null, 'c-1')).not.toThrow()
    expect(() => mgr.setRoomStateFromClient('lobby:r', undefined as any, 'c-1')).not.toThrow()
    expect(() => mgr.setRoomStateFromClient('lobby:r', 'string-payload' as any, 'c-1')).not.toThrow()

    const state = (mgr as any).rooms.get('lobby:r').state
    expect(state.count).toBe(0)
  })
})
