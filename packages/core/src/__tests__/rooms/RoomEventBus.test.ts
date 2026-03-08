// Tests for RoomEventBus — pub/sub, reverse index, unsubscribe, clearRoom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RoomEventBus, createTypedRoomEventBus } from '../../rooms/RoomEventBus'
import { spyOnConsole } from '../helpers'

describe('RoomEventBus (class)', () => {
  let bus: RoomEventBus

  beforeEach(() => {
    bus = new RoomEventBus()
  })

  describe('on() + emit()', () => {
    it('subscribes and receives events', () => {
      const handler = vi.fn()
      bus.on('chat', 'room-1', 'message', 'comp-1', handler)

      const notified = bus.emit('chat', 'room-1', 'message', { text: 'hello' })

      expect(notified).toBe(1)
      expect(handler).toHaveBeenCalledWith({ text: 'hello' })
    })

    it('supports multiple subscribers to same event', () => {
      const h1 = vi.fn()
      const h2 = vi.fn()
      bus.on('chat', 'room-1', 'message', 'comp-1', h1)
      bus.on('chat', 'room-1', 'message', 'comp-2', h2)

      const notified = bus.emit('chat', 'room-1', 'message', { text: 'hi' })

      expect(notified).toBe(2)
      expect(h1).toHaveBeenCalledOnce()
      expect(h2).toHaveBeenCalledOnce()
    })

    it('excludes specified componentId on emit', () => {
      const h1 = vi.fn()
      const h2 = vi.fn()
      bus.on('chat', 'room-1', 'message', 'comp-1', h1)
      bus.on('chat', 'room-1', 'message', 'comp-2', h2)

      const notified = bus.emit('chat', 'room-1', 'message', { text: 'hi' }, 'comp-1')

      expect(notified).toBe(1)
      expect(h1).not.toHaveBeenCalled()
      expect(h2).toHaveBeenCalledOnce()
    })

    it('returns 0 when no subscribers exist', () => {
      const notified = bus.emit('chat', 'room-1', 'message', {})
      expect(notified).toBe(0)
    })

    it('catches handler errors and continues', () => {
      const consoleSpy = spyOnConsole()
      const h1 = vi.fn(() => { throw new Error('boom') })
      const h2 = vi.fn()

      bus.on('chat', 'room-1', 'message', 'comp-1', h1)
      bus.on('chat', 'room-1', 'message', 'comp-2', h2)

      const notified = bus.emit('chat', 'room-1', 'message', {})

      expect(notified).toBe(1) // h1 threw, h2 notified
      expect(h2).toHaveBeenCalledOnce()
      expect(consoleSpy.calls.error.length).toBe(1)
      consoleSpy.restore()
    })

    it('does not cross-fire events between different rooms', () => {
      const h1 = vi.fn()
      const h2 = vi.fn()
      bus.on('chat', 'room-1', 'message', 'comp-1', h1)
      bus.on('chat', 'room-2', 'message', 'comp-2', h2)

      bus.emit('chat', 'room-1', 'message', { text: 'only for room-1' })

      expect(h1).toHaveBeenCalledOnce()
      expect(h2).not.toHaveBeenCalled()
    })

    it('does not cross-fire events between different event names', () => {
      const h1 = vi.fn()
      const h2 = vi.fn()
      bus.on('chat', 'room-1', 'message', 'comp-1', h1)
      bus.on('chat', 'room-1', 'typing', 'comp-2', h2)

      bus.emit('chat', 'room-1', 'message', {})

      expect(h1).toHaveBeenCalledOnce()
      expect(h2).not.toHaveBeenCalled()
    })
  })

  describe('unsubscribe (returned function)', () => {
    it('removes specific subscription', () => {
      const handler = vi.fn()
      const unsub = bus.on('chat', 'room-1', 'message', 'comp-1', handler)

      unsub()
      bus.emit('chat', 'room-1', 'message', {})

      expect(handler).not.toHaveBeenCalled()
    })

    it('only removes the specific subscription, not all', () => {
      const h1 = vi.fn()
      const h2 = vi.fn()
      const unsub1 = bus.on('chat', 'room-1', 'message', 'comp-1', h1)
      bus.on('chat', 'room-1', 'message', 'comp-2', h2)

      unsub1()
      bus.emit('chat', 'room-1', 'message', {})

      expect(h1).not.toHaveBeenCalled()
      expect(h2).toHaveBeenCalledOnce()
    })
  })

  describe('unsubscribeAll()', () => {
    it('removes all subscriptions for a componentId', () => {
      const h1 = vi.fn()
      const h2 = vi.fn()
      bus.on('chat', 'room-1', 'message', 'comp-1', h1)
      bus.on('chat', 'room-1', 'typing', 'comp-1', h2)

      const removed = bus.unsubscribeAll('comp-1')

      expect(removed).toBe(2)
      bus.emit('chat', 'room-1', 'message', {})
      bus.emit('chat', 'room-1', 'typing', {})
      expect(h1).not.toHaveBeenCalled()
      expect(h2).not.toHaveBeenCalled()
    })

    it('does not affect other components', () => {
      const h1 = vi.fn()
      const h2 = vi.fn()
      bus.on('chat', 'room-1', 'message', 'comp-1', h1)
      bus.on('chat', 'room-1', 'message', 'comp-2', h2)

      bus.unsubscribeAll('comp-1')
      bus.emit('chat', 'room-1', 'message', {})

      expect(h1).not.toHaveBeenCalled()
      expect(h2).toHaveBeenCalledOnce()
    })

    it('returns 0 for unknown componentId', () => {
      const removed = bus.unsubscribeAll('unknown')
      expect(removed).toBe(0)
    })

    it('handles component with subscriptions across multiple rooms', () => {
      const h1 = vi.fn()
      const h2 = vi.fn()
      bus.on('chat', 'room-1', 'message', 'comp-1', h1)
      bus.on('game', 'room-2', 'move', 'comp-1', h2)

      const removed = bus.unsubscribeAll('comp-1')
      expect(removed).toBe(2)
    })
  })

  describe('clearRoom()', () => {
    it('removes all subscriptions for a room', () => {
      const h1 = vi.fn()
      const h2 = vi.fn()
      bus.on('chat', 'room-1', 'message', 'comp-1', h1)
      bus.on('chat', 'room-1', 'typing', 'comp-2', h2)

      const removed = bus.clearRoom('chat', 'room-1')

      expect(removed).toBe(2)
      expect(bus.emit('chat', 'room-1', 'message', {})).toBe(0)
    })

    it('does not affect other rooms', () => {
      const h1 = vi.fn()
      const h2 = vi.fn()
      bus.on('chat', 'room-1', 'message', 'comp-1', h1)
      bus.on('chat', 'room-2', 'message', 'comp-2', h2)

      bus.clearRoom('chat', 'room-1')

      expect(bus.emit('chat', 'room-2', 'message', {})).toBe(1)
      expect(h2).toHaveBeenCalledOnce()
    })

    it('cleans reverse index for affected components', () => {
      bus.on('chat', 'room-1', 'message', 'comp-1', vi.fn())
      bus.clearRoom('chat', 'room-1')

      // After clearRoom, unsubscribeAll should not find stale keys
      const removed = bus.unsubscribeAll('comp-1')
      expect(removed).toBe(0)
    })
  })

  describe('getStats()', () => {
    it('returns correct subscription statistics', () => {
      bus.on('chat', 'room-1', 'message', 'comp-1', vi.fn())
      bus.on('chat', 'room-1', 'message', 'comp-2', vi.fn())
      bus.on('chat', 'room-1', 'typing', 'comp-3', vi.fn())
      bus.on('game', 'room-2', 'move', 'comp-4', vi.fn())

      const stats = bus.getStats()

      expect(stats.totalSubscriptions).toBe(4)
      expect(stats.rooms['chat:room-1'].events['message']).toBe(2)
      expect(stats.rooms['chat:room-1'].events['typing']).toBe(1)
      expect(stats.rooms['game:room-2'].events['move']).toBe(1)
    })

    it('returns empty stats when no subscriptions', () => {
      const stats = bus.getStats()
      expect(stats.totalSubscriptions).toBe(0)
      expect(Object.keys(stats.rooms)).toHaveLength(0)
    })
  })
})

describe('createTypedRoomEventBus (factory)', () => {
  type TestRoomEvents = {
    [key: string]: Record<string, any>
    chat: { message: { text: string }; typing: { userId: string } }
    game: { move: { x: number; y: number } }
  }

  it('provides type-safe subscribe and emit', () => {
    const bus = createTypedRoomEventBus<TestRoomEvents>()
    const handler = vi.fn()

    bus.on('chat', 'room-1', 'message', 'comp-1', handler)
    bus.emit('chat', 'room-1', 'message', { text: 'hello' })

    expect(handler).toHaveBeenCalledWith({ text: 'hello' })
  })

  it('supports unsubscribeAll', () => {
    const bus = createTypedRoomEventBus<TestRoomEvents>()
    bus.on('chat', 'room-1', 'message', 'comp-1', vi.fn())
    bus.on('game', 'room-2', 'move', 'comp-1', vi.fn())

    const removed = bus.unsubscribeAll('comp-1')
    expect(removed).toBe(2)
  })

  it('supports clearRoom', () => {
    const bus = createTypedRoomEventBus<TestRoomEvents>()
    bus.on('chat', 'room-1', 'message', 'comp-1', vi.fn())
    bus.on('chat', 'room-1', 'typing', 'comp-2', vi.fn())

    const removed = bus.clearRoom('chat', 'room-1')
    expect(removed).toBe(2)
  })

  it('returns stats', () => {
    const bus = createTypedRoomEventBus<TestRoomEvents>()
    bus.on('chat', 'room-1', 'message', 'comp-1', vi.fn())

    const stats = bus.getStats()
    expect(stats.totalSubscriptions).toBe(1)
  })
})
