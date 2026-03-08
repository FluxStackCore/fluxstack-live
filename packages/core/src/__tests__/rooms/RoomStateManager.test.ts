// Tests for RoomStateManager — state storage, component counting, cleanup
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RoomStateManager, createTypedRoomState } from '../../rooms/RoomStateManager'

describe('RoomStateManager (class)', () => {
  let manager: RoomStateManager

  beforeEach(() => {
    manager = new RoomStateManager()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('get()', () => {
    it('returns empty object when room does not exist and no default', () => {
      const state = manager.get('room-1')
      expect(state).toEqual({})
    })

    it('initializes room with default state', () => {
      const state = manager.get('room-1', { score: 0, players: [] })
      expect(state).toEqual({ score: 0, players: [] })
      expect(manager.has('room-1')).toBe(true)
    })

    it('returns existing state on subsequent gets', () => {
      manager.get('room-1', { score: 0 })
      manager.update('room-1', { score: 10 })

      const state = manager.get('room-1')
      expect(state).toEqual({ score: 10 })
    })
  })

  describe('update()', () => {
    it('merges updates into existing state', () => {
      manager.get('room-1', { a: 1, b: 2 })
      const result = manager.update('room-1', { b: 3, c: 4 })
      expect(result).toEqual({ a: 1, b: 3, c: 4 })
    })

    it('creates room if it does not exist', () => {
      const result = manager.update('new-room', { x: 5 })
      expect(result).toEqual({ x: 5 })
      expect(manager.has('new-room')).toBe(true)
    })
  })

  describe('set()', () => {
    it('replaces entire state', () => {
      manager.get('room-1', { a: 1, b: 2 })
      manager.set('room-1', { c: 3 })

      const state = manager.get('room-1')
      expect(state).toEqual({ c: 3 })
    })

    it('creates room if it does not exist', () => {
      manager.set('new-room', { x: 1 })
      expect(manager.has('new-room')).toBe(true)
      expect(manager.get('new-room')).toEqual({ x: 1 })
    })
  })

  describe('join() + leave()', () => {
    it('increments component count on join', () => {
      manager.get('room-1', { score: 0 })
      manager.join('room-1')
      manager.join('room-1')

      const stats = manager.getStats()
      expect(stats.rooms['room-1'].componentCount).toBe(2)
    })

    it('decrements component count on leave', () => {
      manager.get('room-1', { score: 0 })
      manager.join('room-1')
      manager.join('room-1')
      manager.leave('room-1')

      const stats = manager.getStats()
      expect(stats.rooms['room-1'].componentCount).toBe(1)
    })

    it('schedules cleanup when count reaches 0', () => {
      manager.get('room-1', { score: 0 })
      manager.join('room-1')
      manager.leave('room-1')

      // Room still exists immediately
      expect(manager.has('room-1')).toBe(true)

      // After 5 minutes, room should be cleaned up
      vi.advanceTimersByTime(5 * 60 * 1000 + 100)
      expect(manager.has('room-1')).toBe(false)
    })

    it('does not cleanup if someone rejoins before timeout', () => {
      manager.get('room-1', { score: 0 })
      manager.join('room-1')
      manager.leave('room-1')

      // Rejoin before timeout
      manager.join('room-1')
      vi.advanceTimersByTime(5 * 60 * 1000 + 100)

      // Room should still exist
      expect(manager.has('room-1')).toBe(true)
    })

    it('join on non-existent room is a no-op', () => {
      manager.join('nonexistent')
      // Should not throw
      expect(manager.has('nonexistent')).toBe(false)
    })

    it('leave on non-existent room is a no-op', () => {
      manager.leave('nonexistent')
      // Should not throw
    })
  })

  describe('has()', () => {
    it('returns true for existing rooms', () => {
      manager.get('room-1', {})
      expect(manager.has('room-1')).toBe(true)
    })

    it('returns false for non-existing rooms', () => {
      expect(manager.has('nonexistent')).toBe(false)
    })
  })

  describe('delete()', () => {
    it('removes a room immediately', () => {
      manager.get('room-1', { score: 0 })
      const deleted = manager.delete('room-1')

      expect(deleted).toBe(true)
      expect(manager.has('room-1')).toBe(false)
    })

    it('returns false for non-existing rooms', () => {
      expect(manager.delete('nonexistent')).toBe(false)
    })
  })

  describe('getStats()', () => {
    it('returns correct statistics', () => {
      manager.get('room-1', { a: 1, b: 2 })
      manager.get('room-2', { x: 1 })
      manager.join('room-1')

      const stats = manager.getStats()

      expect(stats.totalRooms).toBe(2)
      expect(stats.rooms['room-1'].componentCount).toBe(1)
      expect(stats.rooms['room-1'].stateKeys).toEqual(['a', 'b'])
      expect(stats.rooms['room-2'].componentCount).toBe(0)
      expect(stats.rooms['room-2'].stateKeys).toEqual(['x'])
    })
  })
})

describe('createTypedRoomState (factory)', () => {
  type TestRoomTypes = {
    [key: string]: Record<string, any>
    chat: { messages: string[]; userCount: number }
    game: { score: number; round: number }
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('get() returns typed default state', () => {
    const state = createTypedRoomState<TestRoomTypes>()
    const chatState = state.get('chat', 'room-1', { messages: [], userCount: 0 })
    expect(chatState).toEqual({ messages: [], userCount: 0 })
  })

  it('update() returns typed merged state', () => {
    const state = createTypedRoomState<TestRoomTypes>()
    state.get('game', 'room-1', { score: 0, round: 1 })
    const updated = state.update('game', 'room-1', { score: 10 })
    expect(updated).toEqual({ score: 10, round: 1 })
  })

  it('set() replaces entire state', () => {
    const state = createTypedRoomState<TestRoomTypes>()
    state.get('game', 'room-1', { score: 0, round: 1 })
    state.set('game', 'room-1', { score: 100, round: 5 })
    expect(state.get('game', 'room-1', { score: 0, round: 0 })).toEqual({ score: 100, round: 5 })
  })

  it('join/leave tracks component count', () => {
    const state = createTypedRoomState<TestRoomTypes>()
    state.get('chat', 'room-1', { messages: [], userCount: 0 })
    state.join('chat', 'room-1')
    state.join('chat', 'room-1')

    const stats = state.getStats()
    expect(stats.rooms['chat:room-1'].componentCount).toBe(2)
  })

  it('leave schedules cleanup when count reaches 0', () => {
    const state = createTypedRoomState<TestRoomTypes>()
    state.get('chat', 'room-1', { messages: [], userCount: 0 })
    state.join('chat', 'room-1')
    state.leave('chat', 'room-1')

    expect(state.has('chat', 'room-1')).toBe(true)
    vi.advanceTimersByTime(5 * 60 * 1000 + 100)
    expect(state.has('chat', 'room-1')).toBe(false)
  })

  it('has/delete work correctly', () => {
    const state = createTypedRoomState<TestRoomTypes>()
    state.get('game', 'room-1', { score: 0, round: 1 })

    expect(state.has('game', 'room-1')).toBe(true)
    state.delete('game', 'room-1')
    expect(state.has('game', 'room-1')).toBe(false)
  })
})
