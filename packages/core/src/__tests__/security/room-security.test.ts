// Tests for Room Security in LiveServer — membership checks, authorizeRoom, serverOnlyState
//
// Tests the handleRoomMessage() security layer via LiveServer's WebSocket flow.
// Creates a LiveServer with a mock transport, captures the onOpen/onMessage callbacks,
// then simulates client messages to verify security enforcement.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LiveServer } from '../../server/LiveServer'
import { createMockWS, spyOnConsole } from '../helpers'
import { AuthenticatedContext, ANONYMOUS_CONTEXT } from '../../auth/LiveAuthContext'
import type { LiveTransport, WebSocketConfig, HttpRouteDefinition, GenericWebSocket } from '../../transport/types'
import type { LiveAuthProvider } from '../../auth/types'

// Mock WsSendBatcher — sendImmediate is used by LiveServer to reply
vi.mock('../../transport/WsSendBatcher', () => ({
  queueWsMessage: vi.fn(),
  queuePreSerialized: vi.fn(),
  sendImmediate: vi.fn(),
  setResyncHandler: vi.fn(),
}))

// Mock LiveLogger to suppress output
vi.mock('../../debug/LiveLogger', () => ({
  liveLog: vi.fn(),
  liveWarn: vi.fn(),
}))

import { sendImmediate } from '../../transport/WsSendBatcher'

// ===== Mock Transport =====

function createMockTransport(): LiveTransport & { wsConfig: WebSocketConfig | null } {
  const mock: any = {
    wsConfig: null,
    async registerWebSocket(config: WebSocketConfig) {
      mock.wsConfig = config
    },
    async registerHttpRoutes(_routes: HttpRouteDefinition[]) {},
  }
  return mock
}

// ===== Helpers =====

/** Parse the JSON string from the last sendImmediate call */
function getLastResponse(): any {
  const calls = (sendImmediate as any).mock.calls
  if (calls.length === 0) return null
  return JSON.parse(calls[calls.length - 1][1])
}

/** Parse all sendImmediate responses */
function getAllResponses(): any[] {
  return (sendImmediate as any).mock.calls.map((c: any) => JSON.parse(c[1]))
}

/** Create a room message for the WS flow */
function roomMsg(type: string, componentId: string, roomId: string, payload?: any, requestId?: string) {
  return JSON.stringify({
    type,
    componentId,
    payload: { roomId, ...payload },
    requestId,
    timestamp: Date.now(),
  })
}

describe('Room Security - LiveServer', () => {
  let server: LiveServer
  let transport: ReturnType<typeof createMockTransport>
  let consoleSpy: ReturnType<typeof spyOnConsole>

  beforeEach(async () => {
    consoleSpy = spyOnConsole()
    transport = createMockTransport()
    server = new LiveServer({
      transport,
      httpPrefix: false, // skip HTTP routes
    })
    await server.start()
    vi.clearAllMocks()
  })

  afterEach(() => {
    consoleSpy.restore()
  })

  /** Simulate a client connection opening */
  function openConnection(ws: GenericWebSocket) {
    transport.wsConfig!.onOpen(ws)
  }

  /** Simulate a client sending a JSON message */
  async function sendMessage(ws: GenericWebSocket, msg: string) {
    await transport.wsConfig!.onMessage(ws, msg, false)
  }

  /** Join a room and return the response */
  async function joinRoom(ws: GenericWebSocket, componentId: string, roomId: string, initialState?: any) {
    vi.clearAllMocks()
    await sendMessage(ws, roomMsg('ROOM_JOIN', componentId, roomId, initialState ? { initialState } : undefined, 'req-join'))
    return getLastResponse()
  }

  describe('Membership checks', () => {
    it('should block ROOM_EMIT from non-member', async () => {
      const ws = createMockWS()
      openConnection(ws)

      // Try to emit without joining
      await sendMessage(ws, roomMsg('ROOM_EMIT', 'comp-1', 'secret-room', { event: 'msg', data: 'hi' }, 'req-1'))

      const resp = getLastResponse()
      expect(resp.type).toBe('ERROR')
      expect(resp.error).toBe('Not a member of this room')
    })

    it('should block ROOM_STATE_SET from non-member', async () => {
      const ws = createMockWS()
      openConnection(ws)

      await sendMessage(ws, roomMsg('ROOM_STATE_SET', 'comp-1', 'secret-room', { state: { hacked: true } }, 'req-1'))

      const resp = getLastResponse()
      expect(resp.type).toBe('ERROR')
      expect(resp.error).toBe('Not a member of this room')
    })

    it('should block ROOM_STATE_GET from non-member', async () => {
      const ws = createMockWS()
      openConnection(ws)

      await sendMessage(ws, roomMsg('ROOM_STATE_GET', 'comp-1', 'secret-room', undefined, 'req-1'))

      const resp = getLastResponse()
      expect(resp.type).toBe('ERROR')
      expect(resp.error).toBe('Not a member of this room')
    })

    it('should allow ROOM_EMIT from member', async () => {
      const ws = createMockWS()
      openConnection(ws)

      // Join the room first
      await joinRoom(ws, 'comp-1', 'chat-room')

      // Now emit — should succeed (no ERROR response)
      vi.clearAllMocks()
      await sendMessage(ws, roomMsg('ROOM_EMIT', 'comp-1', 'chat-room', { event: 'msg', data: 'hello' }))

      // ROOM_EMIT doesn't send a response on success — verify no ERROR
      const responses = getAllResponses()
      const errors = responses.filter(r => r.type === 'ERROR')
      expect(errors).toHaveLength(0)
    })

    it('should allow ROOM_STATE_SET from member', async () => {
      const ws = createMockWS()
      openConnection(ws)

      await joinRoom(ws, 'comp-1', 'data-room', { value: 0 })

      vi.clearAllMocks()
      await sendMessage(ws, roomMsg('ROOM_STATE_SET', 'comp-1', 'data-room', { state: { value: 42 } }))

      // No error — state was set
      const responses = getAllResponses()
      const errors = responses.filter(r => r.type === 'ERROR')
      expect(errors).toHaveLength(0)
    })

    it('should allow ROOM_STATE_GET from member', async () => {
      const ws = createMockWS()
      openConnection(ws)

      await joinRoom(ws, 'comp-1', 'data-room', { score: 100 })

      vi.clearAllMocks()
      await sendMessage(ws, roomMsg('ROOM_STATE_GET', 'comp-1', 'data-room', undefined, 'req-get'))

      const resp = getLastResponse()
      expect(resp.type).toBe('ROOM_STATE')
      expect(resp.payload.state).toEqual({ score: 100 })
    })

    it('should block operations after leaving room', async () => {
      const ws = createMockWS()
      openConnection(ws)

      // Join then leave
      await joinRoom(ws, 'comp-1', 'temp-room')
      await sendMessage(ws, roomMsg('ROOM_LEAVE', 'comp-1', 'temp-room'))

      // Try to emit after leaving
      vi.clearAllMocks()
      await sendMessage(ws, roomMsg('ROOM_EMIT', 'comp-1', 'temp-room', { event: 'msg', data: 'hi' }, 'req-x'))

      const resp = getLastResponse()
      expect(resp.type).toBe('ERROR')
      expect(resp.error).toBe('Not a member of this room')
    })

    it('should allow operations from one member while blocking another', async () => {
      const ws1 = createMockWS()
      const ws2 = createMockWS()
      openConnection(ws1)
      openConnection(ws2)

      // Only comp-1 joins the room
      await joinRoom(ws1, 'comp-1', 'exclusive-room')

      // comp-1 can emit
      vi.clearAllMocks()
      await sendMessage(ws1, roomMsg('ROOM_EMIT', 'comp-1', 'exclusive-room', { event: 'test', data: {} }))
      const resp1 = getAllResponses().filter(r => r.type === 'ERROR')
      expect(resp1).toHaveLength(0)

      // comp-2 (not a member) cannot emit
      vi.clearAllMocks()
      await sendMessage(ws2, roomMsg('ROOM_EMIT', 'comp-2', 'exclusive-room', { event: 'test', data: {} }, 'req-2'))
      const resp2 = getLastResponse()
      expect(resp2.type).toBe('ERROR')
      expect(resp2.error).toBe('Not a member of this room')
    })
  })

  describe('Server-only room state', () => {
    it('should block client ROOM_STATE_SET when room has serverOnlyState', async () => {
      const ws = createMockWS()
      openConnection(ws)

      // Manually create a server-only room via the room manager
      await server.roomManager.joinRoom('comp-1', 'game-state', ws, { hp: 100 }, { serverOnlyState: true })

      // Client tries to set state
      vi.clearAllMocks()
      await sendMessage(ws, roomMsg('ROOM_STATE_SET', 'comp-1', 'game-state', { state: { hp: 999 } }, 'req-set'))

      const resp = getLastResponse()
      expect(resp.type).toBe('ERROR')
      expect(resp.error).toBe('Room state is server-only')
    })

    it('should allow server-side setRoomState on serverOnlyState rooms', async () => {
      const ws = createMockWS()
      openConnection(ws)

      await server.roomManager.joinRoom('comp-1', 'game-state', ws, { hp: 100 }, { serverOnlyState: true })

      // Server-side update should work fine (via room manager directly)
      server.roomManager.setRoomState('game-state', { hp: 50 })
      expect(server.roomManager.getRoomState('game-state')).toEqual({ hp: 50 })
    })

    it('should allow ROOM_STATE_GET even on serverOnlyState rooms', async () => {
      const ws = createMockWS()
      openConnection(ws)

      await server.roomManager.joinRoom('comp-1', 'game-state', ws, { hp: 100 }, { serverOnlyState: true })

      vi.clearAllMocks()
      await sendMessage(ws, roomMsg('ROOM_STATE_GET', 'comp-1', 'game-state', undefined, 'req-get'))

      const resp = getLastResponse()
      expect(resp.type).toBe('ROOM_STATE')
      expect(resp.payload.state).toEqual({ hp: 100 })
    })

    it('should allow ROOM_EMIT on serverOnlyState rooms (only state writes blocked)', async () => {
      const ws = createMockWS()
      openConnection(ws)

      await server.roomManager.joinRoom('comp-1', 'game-state', ws, { hp: 100 }, { serverOnlyState: true })

      vi.clearAllMocks()
      await sendMessage(ws, roomMsg('ROOM_EMIT', 'comp-1', 'game-state', { event: 'ping', data: {} }))

      const responses = getAllResponses()
      const errors = responses.filter(r => r.type === 'ERROR')
      expect(errors).toHaveLength(0)
    })

    it('should allow client ROOM_STATE_SET when room is NOT serverOnlyState', async () => {
      const ws = createMockWS()
      openConnection(ws)

      await server.roomManager.joinRoom('comp-1', 'chat', ws, { messages: [] }, { serverOnlyState: false })

      vi.clearAllMocks()
      await sendMessage(ws, roomMsg('ROOM_STATE_SET', 'comp-1', 'chat', { state: { messages: ['hello'] } }))

      const responses = getAllResponses()
      const errors = responses.filter(r => r.type === 'ERROR')
      expect(errors).toHaveLength(0)

      expect(server.roomManager.getRoomState('chat')).toEqual({ messages: ['hello'] })
    })
  })

  describe('Room authorization (authorizeRoom)', () => {
    it('should allow ROOM_JOIN when no auth provider is registered', async () => {
      const ws = createMockWS()
      openConnection(ws)

      await sendMessage(ws, roomMsg('ROOM_JOIN', 'comp-1', 'open-room', undefined, 'req-join'))

      const resp = getLastResponse()
      expect(resp.type).toBe('ROOM_JOINED')
      expect(resp.payload.roomId).toBe('open-room')
    })

    it('should allow ROOM_JOIN when auth provider allows room access', async () => {
      const provider: LiveAuthProvider = {
        name: 'test-auth',
        async authenticate() { return ANONYMOUS_CONTEXT },
        async authorizeRoom(_authContext, _roomId) { return true },
      }
      server.useAuth(provider)

      const ws = createMockWS()
      openConnection(ws)

      await sendMessage(ws, roomMsg('ROOM_JOIN', 'comp-1', 'allowed-room', undefined, 'req-join'))

      const resp = getLastResponse()
      expect(resp.type).toBe('ROOM_JOINED')
    })

    it('should block ROOM_JOIN when auth provider denies room access', async () => {
      const provider: LiveAuthProvider = {
        name: 'test-auth',
        async authenticate() { return ANONYMOUS_CONTEXT },
        async authorizeRoom(_authContext, _roomId) { return false },
      }
      server.useAuth(provider)

      const ws = createMockWS()
      openConnection(ws)

      await sendMessage(ws, roomMsg('ROOM_JOIN', 'comp-1', 'private-room', undefined, 'req-join'))

      const resp = getLastResponse()
      expect(resp.type).toBe('ERROR')
      expect(resp.error).toContain('denied')
    })

    it('should pass auth context to authorizeRoom', async () => {
      const authorizeFn = vi.fn().mockResolvedValue(true)

      const provider: LiveAuthProvider = {
        name: 'test-auth',
        async authenticate(creds) {
          if (creds.token === 'valid') {
            return new AuthenticatedContext({ id: 'user-1', roles: ['admin'] })
          }
          return ANONYMOUS_CONTEXT
        },
        authorizeRoom: authorizeFn,
      }
      server.useAuth(provider)

      // Simulate authenticated WebSocket
      const ws = createMockWS()
      openConnection(ws)

      // Authenticate first
      await sendMessage(ws, JSON.stringify({
        type: 'AUTH',
        componentId: '',
        payload: { token: 'valid' },
        timestamp: Date.now(),
      }))

      vi.clearAllMocks()
      await sendMessage(ws, roomMsg('ROOM_JOIN', 'comp-1', 'admin-room', undefined, 'req-join'))

      // authorizeRoom was called with the authenticated context
      expect(authorizeFn).toHaveBeenCalledTimes(1)
      const [calledCtx, calledRoomId] = authorizeFn.mock.calls[0]
      expect(calledCtx.authenticated).toBe(true)
      expect(calledCtx.session.id).toBe('user-1')
      expect(calledRoomId).toBe('admin-room')
    })

    it('should use ANONYMOUS_CONTEXT when ws has no auth context', async () => {
      const authorizeFn = vi.fn().mockResolvedValue(false)

      const provider: LiveAuthProvider = {
        name: 'test-auth',
        async authenticate() { return ANONYMOUS_CONTEXT },
        authorizeRoom: authorizeFn,
      }
      server.useAuth(provider)

      const ws = createMockWS()
      openConnection(ws)

      await sendMessage(ws, roomMsg('ROOM_JOIN', 'comp-1', 'private-room', undefined, 'req-join'))

      expect(authorizeFn).toHaveBeenCalledTimes(1)
      const [calledCtx] = authorizeFn.mock.calls[0]
      expect(calledCtx.authenticated).toBe(false)
    })

    it('should selectively authorize rooms based on roomId', async () => {
      const provider: LiveAuthProvider = {
        name: 'test-auth',
        async authenticate() { return ANONYMOUS_CONTEXT },
        async authorizeRoom(_authContext, roomId) {
          // Only allow rooms that don't start with 'admin:'
          return !roomId.startsWith('admin:')
        },
      }
      server.useAuth(provider)

      const ws = createMockWS()
      openConnection(ws)

      // Public room — allowed
      await sendMessage(ws, roomMsg('ROOM_JOIN', 'comp-1', 'chat:lobby', undefined, 'req-1'))
      const resp1 = getLastResponse()
      expect(resp1.type).toBe('ROOM_JOINED')

      // Admin room — denied
      vi.clearAllMocks()
      await sendMessage(ws, roomMsg('ROOM_JOIN', 'comp-2', 'admin:dashboard', undefined, 'req-2'))
      const resp2 = getLastResponse()
      expect(resp2.type).toBe('ERROR')
      expect(resp2.error).toContain('denied')
    })

    it('should handle authorizeRoom throwing an error gracefully', async () => {
      const provider: LiveAuthProvider = {
        name: 'test-auth',
        async authenticate() { return ANONYMOUS_CONTEXT },
        async authorizeRoom() {
          throw new Error('Database connection failed')
        },
      }
      server.useAuth(provider)

      const ws = createMockWS()
      openConnection(ws)

      await sendMessage(ws, roomMsg('ROOM_JOIN', 'comp-1', 'some-room', undefined, 'req-1'))

      const resp = getLastResponse()
      expect(resp.type).toBe('ERROR')
      expect(resp.error).toContain('error')
    })
  })

  describe('Combined security scenarios', () => {
    it('should enforce both membership AND serverOnlyState', async () => {
      const ws1 = createMockWS()
      const ws2 = createMockWS()
      openConnection(ws1)
      openConnection(ws2)

      // comp-1 joins a serverOnlyState room
      await server.roomManager.joinRoom('comp-1', 'game', ws1, { score: 0 }, { serverOnlyState: true })

      // comp-1 (member) tries ROOM_STATE_SET → blocked by serverOnlyState
      vi.clearAllMocks()
      await sendMessage(ws1, roomMsg('ROOM_STATE_SET', 'comp-1', 'game', { state: { score: 999 } }, 'req-1'))
      const resp1 = getLastResponse()
      expect(resp1.type).toBe('ERROR')
      expect(resp1.error).toBe('Room state is server-only')

      // comp-2 (non-member) tries ROOM_STATE_SET → blocked by membership check first
      vi.clearAllMocks()
      await sendMessage(ws2, roomMsg('ROOM_STATE_SET', 'comp-2', 'game', { state: { score: 999 } }, 'req-2'))
      const resp2 = getLastResponse()
      expect(resp2.type).toBe('ERROR')
      expect(resp2.error).toBe('Not a member of this room')
    })

    it('should enforce auth + membership together', async () => {
      const provider: LiveAuthProvider = {
        name: 'test-auth',
        async authenticate() { return ANONYMOUS_CONTEXT },
        async authorizeRoom(_ctx, roomId) {
          return roomId === 'public-room'
        },
      }
      server.useAuth(provider)

      const ws = createMockWS()
      openConnection(ws)

      // Step 1: Try to join private room → denied by auth
      await sendMessage(ws, roomMsg('ROOM_JOIN', 'comp-1', 'private-room', undefined, 'req-1'))
      const resp1 = getLastResponse()
      expect(resp1.type).toBe('ERROR')

      // Step 2: Try to emit to private room → denied by membership (never joined)
      vi.clearAllMocks()
      await sendMessage(ws, roomMsg('ROOM_EMIT', 'comp-1', 'private-room', { event: 'x', data: {} }, 'req-2'))
      const resp2 = getLastResponse()
      expect(resp2.type).toBe('ERROR')
      expect(resp2.error).toBe('Not a member of this room')

      // Step 3: Join public room → allowed
      vi.clearAllMocks()
      await sendMessage(ws, roomMsg('ROOM_JOIN', 'comp-1', 'public-room', undefined, 'req-3'))
      const resp3 = getLastResponse()
      expect(resp3.type).toBe('ROOM_JOINED')

      // Step 4: Emit to public room → allowed
      vi.clearAllMocks()
      await sendMessage(ws, roomMsg('ROOM_EMIT', 'comp-1', 'public-room', { event: 'msg', data: 'hi' }))
      const errors = getAllResponses().filter(r => r.type === 'ERROR')
      expect(errors).toHaveLength(0)
    })

    it('should preserve requestId in error responses', async () => {
      const ws = createMockWS()
      openConnection(ws)

      await sendMessage(ws, roomMsg('ROOM_EMIT', 'comp-1', 'no-room', { event: 'x', data: {} }, 'my-req-123'))

      const resp = getLastResponse()
      expect(resp.type).toBe('ERROR')
      expect(resp.requestId).toBe('my-req-123')
      expect(resp.componentId).toBe('comp-1')
    })
  })
})
