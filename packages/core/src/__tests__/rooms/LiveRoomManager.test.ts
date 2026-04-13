// Tests for LiveRoomManager — join, leave, emit, state, cleanup, broadcasting
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LiveRoomManager } from '../../rooms/LiveRoomManager'
import { RoomEventBus } from '../../rooms/RoomEventBus'
import { createMockWS, spyOnConsole } from '../helpers'

// Mock the WsSendBatcher so we can inspect queued messages
vi.mock('../../transport/WsSendBatcher', () => ({
  queueWsMessage: vi.fn(),
  queuePreSerialized: vi.fn(),
  sendImmediate: vi.fn(),
  sendBinaryImmediate: vi.fn(),
}))

// Mock LiveLogger to suppress output
vi.mock('../../debug/LiveLogger', () => ({
  liveLog: vi.fn(),
  liveWarn: vi.fn(),
}))

import { queuePreSerialized } from '../../transport/WsSendBatcher'
import { LiveRoom } from '../../rooms/LiveRoom'

describe('LiveRoomManager', () => {
  let roomEvents: RoomEventBus
  let manager: LiveRoomManager

  beforeEach(() => {
    roomEvents = new RoomEventBus()
    manager = new LiveRoomManager(roomEvents)
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('joinRoom()', () => {
    it('creates room and returns initial state', async () => {
      const ws = createMockWS()
      const result = await manager.joinRoom('comp-1', 'chat:lobby', ws, { messages: [] })

      expect('rejected' in result && result.rejected).toBeFalsy()
      expect((result as any).state).toEqual({ messages: [] })
    })

    it('adds member to existing room', async () => {
      const ws1 = createMockWS()
      const ws2 = createMockWS()
      await manager.joinRoom('comp-1', 'chat:lobby', ws1, { messages: [] })
      await manager.joinRoom('comp-2', 'chat:lobby', ws2)

      expect(manager.isInRoom('comp-1', 'chat:lobby')).toBe(true)
      expect(manager.isInRoom('comp-2', 'chat:lobby')).toBe(true)
    })

    it('broadcasts join notification to other members', async () => {
      const ws1 = createMockWS()
      const ws2 = createMockWS()
      await manager.joinRoom('comp-1', 'chat:lobby', ws1)

      vi.clearAllMocks()
      await manager.joinRoom('comp-2', 'chat:lobby', ws2)

      // Should have broadcast $sub:join to comp-1 (excludes comp-2)
      expect(queuePreSerialized).toHaveBeenCalled()
      const call = (queuePreSerialized as any).mock.calls[0]
      const msg = JSON.parse(call[1])
      expect(msg.event).toBe('$sub:join')
      expect(msg.data.subscriberId).toBe('comp-2')
    })

    it('rejects invalid room names', async () => {
      const ws = createMockWS()
      await expect(manager.joinRoom('comp-1', '', ws)).rejects.toThrow('Invalid room name')
      await expect(manager.joinRoom('comp-1', 'room with spaces', ws)).rejects.toThrow('Invalid room name')
      await expect(manager.joinRoom('comp-1', 'a'.repeat(65), ws)).rejects.toThrow('Invalid room name')
    })

    it('accepts valid room name formats', async () => {
      const ws = createMockWS()
      // All of these should be valid
      await expect(manager.joinRoom('c1', 'simple', ws)).resolves.not.toThrow()
      await expect(manager.joinRoom('c2', 'with-hyphens', ws)).resolves.not.toThrow()
      await expect(manager.joinRoom('c3', 'with_underscores', ws)).resolves.not.toThrow()
      await expect(manager.joinRoom('c4', 'with.dots', ws)).resolves.not.toThrow()
      await expect(manager.joinRoom('c5', 'with:colons', ws)).resolves.not.toThrow()
      await expect(manager.joinRoom('c6', 'MiXeD123', ws)).resolves.not.toThrow()
    })
  })

  describe('leaveRoom()', () => {
    it('removes member from room', async () => {
      const ws = createMockWS()
      await manager.joinRoom('comp-1', 'chat:lobby', ws)
      await manager.leaveRoom('comp-1', 'chat:lobby')

      expect(manager.isInRoom('comp-1', 'chat:lobby')).toBe(false)
    })

    it('broadcasts leave notification to remaining members', async () => {
      const ws1 = createMockWS()
      const ws2 = createMockWS()
      await manager.joinRoom('comp-1', 'chat:lobby', ws1)
      await manager.joinRoom('comp-2', 'chat:lobby', ws2)

      vi.clearAllMocks()
      await manager.leaveRoom('comp-1', 'chat:lobby')

      expect(queuePreSerialized).toHaveBeenCalled()
      const call = (queuePreSerialized as any).mock.calls[0]
      const msg = JSON.parse(call[1])
      expect(msg.event).toBe('$sub:leave')
      expect(msg.data.subscriberId).toBe('comp-1')
    })

    it('schedules empty room cleanup after 5 minutes', async () => {
      const ws = createMockWS()
      await manager.joinRoom('comp-1', 'chat:lobby', ws)
      await manager.leaveRoom('comp-1', 'chat:lobby')

      // Room still exists
      const stats = manager.getStats()
      expect(stats.totalRooms).toBe(1)

      // After 5 minutes, room cleaned up
      vi.advanceTimersByTime(5 * 60 * 1000 + 100)
      const stats2 = manager.getStats()
      expect(stats2.totalRooms).toBe(0)
    })

    it('does not clean up room if someone rejoins before timeout', async () => {
      const ws1 = createMockWS()
      const ws2 = createMockWS()
      await manager.joinRoom('comp-1', 'chat:lobby', ws1)
      await manager.leaveRoom('comp-1', 'chat:lobby')

      await manager.joinRoom('comp-2', 'chat:lobby', ws2)
      vi.advanceTimersByTime(5 * 60 * 1000 + 100)

      expect(manager.isInRoom('comp-2', 'chat:lobby')).toBe(true)
    })

    it('is a no-op for non-existent room', async () => {
      // Should not throw
      await manager.leaveRoom('comp-1', 'nonexistent')
    })
  })

  describe('cleanupComponent()', () => {
    it('removes component from all rooms', async () => {
      const ws = createMockWS()
      await manager.joinRoom('comp-1', 'room-a', ws)
      await manager.joinRoom('comp-1', 'room-b', ws)
      await manager.joinRoom('comp-1', 'room-c', ws)

      await manager.cleanupComponent('comp-1')

      expect(manager.isInRoom('comp-1', 'room-a')).toBe(false)
      expect(manager.isInRoom('comp-1', 'room-b')).toBe(false)
      expect(manager.isInRoom('comp-1', 'room-c')).toBe(false)
    })

    it('broadcasts leave notifications to remaining members', async () => {
      const ws1 = createMockWS()
      const ws2 = createMockWS()
      await manager.joinRoom('comp-1', 'room-a', ws1)
      await manager.joinRoom('comp-2', 'room-a', ws2)

      vi.clearAllMocks()
      await manager.cleanupComponent('comp-1')

      expect(queuePreSerialized).toHaveBeenCalled()
    })

    it('is a no-op for unknown component', async () => {
      // Should not throw
      await manager.cleanupComponent('unknown')
    })

    it('schedules cleanup for empty rooms', async () => {
      const ws = createMockWS()
      await manager.joinRoom('comp-1', 'room-a', ws)
      await manager.cleanupComponent('comp-1')

      vi.advanceTimersByTime(5 * 60 * 1000 + 100)
      expect(manager.getStats().totalRooms).toBe(0)
    })
  })

  describe('emitToRoom()', () => {
    it('emits event on RoomEventBus and broadcasts to members', async () => {
      const ws1 = createMockWS()
      const ws2 = createMockWS()
      const handler = vi.fn()

      await manager.joinRoom('comp-1', 'chat:lobby', ws1)
      await manager.joinRoom('comp-2', 'chat:lobby', ws2)
      roomEvents.on('room', 'chat:lobby', 'chat-msg', 'comp-1', handler)

      const sent = manager.emitToRoom('chat:lobby', 'chat-msg', { text: 'hello' })

      expect(handler).toHaveBeenCalledWith({ text: 'hello' })
      expect(sent).toBe(2) // Both ws1 and ws2
    })

    it('respects excludeComponentId', async () => {
      const ws1 = createMockWS()
      const ws2 = createMockWS()
      await manager.joinRoom('comp-1', 'chat:lobby', ws1)
      await manager.joinRoom('comp-2', 'chat:lobby', ws2)

      vi.clearAllMocks()
      const sent = manager.emitToRoom('chat:lobby', 'msg', { text: 'hi' }, 'comp-1')

      expect(sent).toBe(1) // Only ws2
    })

    it('returns 0 for non-existent room', () => {
      const sent = manager.emitToRoom('nonexistent', 'event', {})
      expect(sent).toBe(0)
    })
  })

  describe('setRoomState()', () => {
    it('updates room state', async () => {
      const ws = createMockWS()
      await manager.joinRoom('comp-1', 'game:1', ws, { score: 0, round: 1 })

      manager.setRoomState('game:1', { score: 10 })

      const state = manager.getRoomState('game:1')
      expect(state).toEqual({ score: 10, round: 1 })
    })

    it('broadcasts state update to members', async () => {
      const ws = createMockWS()
      await manager.joinRoom('comp-1', 'game:1', ws, { score: 0 })

      vi.clearAllMocks()
      manager.setRoomState('game:1', { score: 10 })

      expect(queuePreSerialized).toHaveBeenCalled()
      const call = (queuePreSerialized as any).mock.calls[0]
      const msg = JSON.parse(call[1])
      expect(msg.type).toBe('ROOM_STATE')
      expect(msg.data.state).toEqual({ score: 10 })
    })

    it('is a no-op for non-existent room', () => {
      // Should not throw
      manager.setRoomState('nonexistent', { x: 1 })
    })

    it('throws when state exceeds size limit', async () => {
      const ws = createMockWS()
      await manager.joinRoom('comp-1', 'big-room', ws, {})

      // Create a state update that exceeds 10MB
      const bigData = 'x'.repeat(11 * 1024 * 1024)
      expect(() => manager.setRoomState('big-room', { data: bigData }))
        .toThrow('Room state exceeds maximum size limit')
    })
  })

  describe('LiveRoom.emitWithState()', () => {
    it('calls setRoomState and emitToRoom on the manager in order', () => {

      const calls: string[] = []
      const mockManager = {
        setRoomState: vi.fn(() => calls.push('setState')),
        emitToRoom: vi.fn(() => { calls.push('emit'); return 2 }),
        getMemberCount: vi.fn().mockReturnValue(2),
      } as any

      class RaceRoom extends LiveRoom<{ lap: number }, {}, { 'lap:completed': { player: string } }> {
        static roomName = 'race'
        static defaultState = { lap: 0 }
      }

      const room = new RaceRoom('race:1', mockManager)
      const notified = room.emitWithState('lap:completed', { player: 'p1' }, { lap: 2 })

      expect(mockManager.setRoomState).toHaveBeenCalledWith('race:1', { lap: 2 })
      expect(mockManager.emitToRoom).toHaveBeenCalledWith('race:1', 'lap:completed', { player: 'p1' })
      expect(notified).toBe(2)
      // setState must come before emit
      expect(calls).toEqual(['setState', 'emit'])
    })

    it('returns 0 and does not throw when room has no members', () => {

      const mockManager = {
        setRoomState: vi.fn(),
        emitToRoom: vi.fn().mockReturnValue(0),
        getMemberCount: vi.fn().mockReturnValue(0),
      } as any

      class TestRoom extends LiveRoom<{ x: number }, {}, { moved: { x: number } }> {
        static roomName = 'test'
        static defaultState = { x: 0 }
      }

      const room = new TestRoom('test:1', mockManager)
      const result = room.emitWithState('moved', { x: 10 }, { x: 10 })

      expect(mockManager.setRoomState).toHaveBeenCalledWith('test:1', { x: 10 })
      expect(mockManager.emitToRoom).toHaveBeenCalledWith('test:1', 'moved', { x: 10 })
      expect(result).toBe(0)
    })
  })

  describe('getRoomState()', () => {
    it('returns room state', async () => {
      const ws = createMockWS()
      await manager.joinRoom('comp-1', 'game:1', ws, { score: 5 })

      expect(manager.getRoomState('game:1')).toEqual({ score: 5 })
    })

    it('returns empty object for non-existent room', () => {
      expect(manager.getRoomState('nonexistent')).toEqual({})
    })
  })

  describe('isInRoom()', () => {
    it('returns true when component is in room', async () => {
      const ws = createMockWS()
      await manager.joinRoom('comp-1', 'room-a', ws)
      expect(manager.isInRoom('comp-1', 'room-a')).toBe(true)
    })

    it('returns false when component is not in room', () => {
      expect(manager.isInRoom('comp-1', 'room-a')).toBe(false)
    })
  })

  describe('getComponentRooms()', () => {
    it('returns all rooms for a component', async () => {
      const ws = createMockWS()
      await manager.joinRoom('comp-1', 'room-a', ws)
      await manager.joinRoom('comp-1', 'room-b', ws)

      const rooms = manager.getComponentRooms('comp-1')
      expect(rooms).toContain('room-a')
      expect(rooms).toContain('room-b')
      expect(rooms).toHaveLength(2)
    })

    it('returns empty array for unknown component', () => {
      expect(manager.getComponentRooms('unknown')).toEqual([])
    })
  })

  describe('getStats()', () => {
    it('returns correct room statistics', async () => {
      const ws1 = createMockWS()
      const ws2 = createMockWS()
      await manager.joinRoom('comp-1', 'room-a', ws1)
      await manager.joinRoom('comp-2', 'room-a', ws2)
      await manager.joinRoom('comp-1', 'room-b', ws1)

      const stats = manager.getStats()

      expect(stats.totalRooms).toBe(2)
      expect(stats.rooms['room-a'].members).toBe(2)
      expect(stats.rooms['room-b'].members).toBe(1)
    })
  })
})
