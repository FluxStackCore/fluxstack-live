// BUG: RoomEventBus componentIndex is never cleaned when individual subscriptions are removed
// Only unsubscribeAll cleans componentIndex, but individual unsubscribe() leaves orphaned entries.
import { describe, it, expect } from 'vitest'
import { RoomEventBus } from '../../rooms/RoomEventBus'

describe('BUG: RoomEventBus componentIndex memory leak', () => {
  it('should clean componentIndex when all subscriptions for a component are individually removed', () => {
    const bus = new RoomEventBus()

    // Component subscribes to 3 events
    const unsub1 = bus.on('room', 'lobby', 'msg', 'comp-1', () => {})
    const unsub2 = bus.on('room', 'lobby', 'join', 'comp-1', () => {})
    const unsub3 = bus.on('room', 'lobby', 'leave', 'comp-1', () => {})

    // Unsubscribe all individually (NOT via unsubscribeAll)
    unsub1()
    unsub2()
    unsub3()

    // The subscriptions Map should be clean
    expect(bus.getStats().totalSubscriptions).toBe(0)

    // BUG: componentIndex still has 'comp-1' entry with stale keys
    // After fix, subscribing and unsubscribing another component should not
    // find orphaned entries from comp-1

    // Verify via unsubscribeAll returning 0 (no subscriptions left to clean)
    const removed = bus.unsubscribeAll('comp-1')
    expect(removed).toBe(0)

    // The real test: after 1000 components subscribe and individually unsubscribe,
    // memory should not grow
    for (let i = 0; i < 1000; i++) {
      const unsub = bus.on('room', 'lobby', 'msg', `ephemeral-${i}`, () => {})
      unsub() // immediately unsubscribe
    }

    // All subscriptions cleaned
    expect(bus.getStats().totalSubscriptions).toBe(0)

    // BUG: componentIndex still has 1000 entries with empty Sets
    // We can verify by checking unsubscribeAll returns 0 for all
    for (let i = 0; i < 1000; i++) {
      expect(bus.unsubscribeAll(`ephemeral-${i}`)).toBe(0)
    }
  })
})
