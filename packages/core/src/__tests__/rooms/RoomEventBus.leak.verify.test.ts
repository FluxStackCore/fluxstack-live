// Verify: RoomEventBus componentIndex is cleaned on individual unsubscribe
// Before fix: componentIndex kept orphaned entries forever
// After fix: componentIndex is cleaned eagerly
import { describe, it, expect } from 'vitest'
import { RoomEventBus } from '../../rooms/RoomEventBus'

describe('RoomEventBus componentIndex cleanup verification', () => {
  it('componentIndex should be empty after all individual unsubscribes', () => {
    const bus = new RoomEventBus()

    // Subscribe 3 events for comp-1
    const unsub1 = bus.on('room', 'lobby', 'msg', 'comp-1', () => {})
    const unsub2 = bus.on('room', 'lobby', 'join', 'comp-1', () => {})
    const unsub3 = bus.on('room', 'lobby', 'leave', 'comp-1', () => {})

    // Individually unsubscribe all
    unsub1()
    unsub2()
    unsub3()

    // If componentIndex is cleaned, unsubscribeAll should find nothing
    // Before fix: unsubscribeAll('comp-1') would find stale keys in componentIndex
    // and try to delete subscriptions that no longer exist, returning 0 but
    // the componentIndex entry itself would persist (memory leak)
    const removed = bus.unsubscribeAll('comp-1')
    expect(removed).toBe(0)

    // Access internal state to verify (white-box test)
    // @ts-ignore — accessing private for verification
    const hasEntry = (bus as any).componentIndex?.has?.('comp-1')
    expect(hasEntry).toBe(false)
  })

  it('1000 ephemeral components should not leave orphaned componentIndex entries', () => {
    const bus = new RoomEventBus()

    for (let i = 0; i < 1000; i++) {
      const unsub = bus.on('room', 'lobby', 'msg', `eph-${i}`, () => {})
      unsub()
    }

    // @ts-ignore
    const indexSize = (bus as any).componentIndex?.size ?? 0
    expect(indexSize).toBe(0)
  })
})
