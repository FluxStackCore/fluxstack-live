// Tests for Room Security — serverOnlyState, deep diff options, isServerOnlyState
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LiveRoomManager } from '../../rooms/LiveRoomManager'
import { RoomEventBus } from '../../rooms/RoomEventBus'
import { createMockWS } from '../helpers'

// Mock the WsSendBatcher so we can inspect queued messages
vi.mock('../../transport/WsSendBatcher', () => ({
  queueWsMessage: vi.fn(),
  queuePreSerialized: vi.fn(),
  sendImmediate: vi.fn(),
}))

// Mock LiveLogger to suppress output
vi.mock('../../debug/LiveLogger', () => ({
  liveLog: vi.fn(),
  liveWarn: vi.fn(),
}))

import { queuePreSerialized } from '../../transport/WsSendBatcher'

describe('Room Security', () => {
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

  describe('isServerOnlyState()', () => {
    it('returns false for rooms created without serverOnlyState', async () => {
      const ws = createMockWS()
      await manager.joinRoom('comp-1', 'room-a', ws, { score: 0 })

      expect(manager.isServerOnlyState('room-a')).toBe(false)
    })

    it('returns false for non-existent rooms', () => {
      expect(manager.isServerOnlyState('nonexistent')).toBe(false)
    })

    it('returns true for rooms created with serverOnlyState: true', async () => {
      const ws = createMockWS()
      await manager.joinRoom('comp-1', 'game-room', ws, { hp: 100 }, { serverOnlyState: true })

      expect(manager.isServerOnlyState('game-room')).toBe(true)
    })

    it('returns false for rooms created with serverOnlyState: false', async () => {
      const ws = createMockWS()
      await manager.joinRoom('comp-1', 'chat-room', ws, {}, { serverOnlyState: false })

      expect(manager.isServerOnlyState('chat-room')).toBe(false)
    })

    it('preserves serverOnlyState when second member joins', async () => {
      const ws1 = createMockWS()
      const ws2 = createMockWS()

      // First member creates room with serverOnlyState
      await manager.joinRoom('comp-1', 'locked-room', ws1, { data: 'x' }, { serverOnlyState: true })

      // Second member joins — room config should not change
      await manager.joinRoom('comp-2', 'locked-room', ws2)

      expect(manager.isServerOnlyState('locked-room')).toBe(true)
    })
  })

  describe('joinRoom() deep diff options', () => {
    it('defaults deepDiff to true', async () => {
      const ws = createMockWS()
      await manager.joinRoom('comp-1', 'room-1', ws, { a: 1 })

      // Verify deep diff is working by updating with same value
      vi.clearAllMocks()
      manager.setRoomState('room-1', { a: 1 })
      // Deep diff detects no change → no broadcast
      expect(queuePreSerialized).not.toHaveBeenCalled()
    })

    it('respects deepDiff: false option', async () => {
      const ws = createMockWS()
      await manager.joinRoom('comp-1', 'room-1', ws, { a: { nested: 1 } }, { deepDiff: false })

      // With shallow diff, a new object reference should trigger broadcast
      vi.clearAllMocks()
      manager.setRoomState('room-1', { a: { nested: 1 } })
      // Shallow diff: reference inequality → sends broadcast
      expect(queuePreSerialized).toHaveBeenCalled()
    })

    it('respects deepDiffDepth option', async () => {
      const ws = createMockWS()
      // Set depth to 1 — only top-level deep diff
      await manager.joinRoom('comp-1', 'room-1', ws, {
        level1: { level2: { value: 'old' } }
      }, { deepDiffDepth: 1 })

      vi.clearAllMocks()

      // Updating with same deep structure but new reference at depth > 1
      // At depth 1, level2 object is compared by reference (exceeds maxDepth)
      manager.setRoomState('room-1', {
        level1: { level2: { value: 'old' } }
      })

      // Should broadcast because at depth 1, the nested object is compared by reference
      expect(queuePreSerialized).toHaveBeenCalled()
    })
  })

  describe('isInRoom() - membership verification', () => {
    it('returns true when component is in room', async () => {
      const ws = createMockWS()
      await manager.joinRoom('comp-1', 'room-a', ws)
      expect(manager.isInRoom('comp-1', 'room-a')).toBe(true)
    })

    it('returns false when component is not in room', () => {
      expect(manager.isInRoom('comp-1', 'room-a')).toBe(false)
    })

    it('returns false after component leaves room', async () => {
      const ws = createMockWS()
      await manager.joinRoom('comp-1', 'room-a', ws)
      await manager.leaveRoom('comp-1', 'room-a')
      expect(manager.isInRoom('comp-1', 'room-a')).toBe(false)
    })

    it('returns false after component cleanup', async () => {
      const ws = createMockWS()
      await manager.joinRoom('comp-1', 'room-a', ws)
      await manager.joinRoom('comp-1', 'room-b', ws)
      await manager.cleanupComponent('comp-1')

      expect(manager.isInRoom('comp-1', 'room-a')).toBe(false)
      expect(manager.isInRoom('comp-1', 'room-b')).toBe(false)
    })

    it('returns false for non-existent room', () => {
      expect(manager.isInRoom('comp-1', 'no-such-room')).toBe(false)
    })

    it('correctly distinguishes between components in same room', async () => {
      const ws1 = createMockWS()
      const ws2 = createMockWS()
      await manager.joinRoom('comp-1', 'room-a', ws1)
      await manager.joinRoom('comp-2', 'room-a', ws2)

      expect(manager.isInRoom('comp-1', 'room-a')).toBe(true)
      expect(manager.isInRoom('comp-2', 'room-a')).toBe(true)
      expect(manager.isInRoom('comp-3', 'room-a')).toBe(false)
    })
  })

  describe('setRoomState() with serverOnlyState', () => {
    it('allows server-side state updates on serverOnlyState rooms', async () => {
      const ws = createMockWS()
      await manager.joinRoom('comp-1', 'game', ws, { hp: 100 }, { serverOnlyState: true })

      // Server-side setRoomState should always work
      manager.setRoomState('game', { hp: 50 })
      expect(manager.getRoomState('game')).toEqual({ hp: 50 })
    })

    it('allows state updates on non-serverOnlyState rooms', async () => {
      const ws = createMockWS()
      await manager.joinRoom('comp-1', 'chat', ws, { messages: [] })

      manager.setRoomState('chat', { messages: ['hello'] })
      expect(manager.getRoomState('chat')).toEqual({ messages: ['hello'] })
    })
  })
})
