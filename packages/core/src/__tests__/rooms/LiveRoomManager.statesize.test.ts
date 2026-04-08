// BUG #9: Room state size estimation is inaccurate
// stateSize += deltaSize is additive, but JSON size isn't additive.
// Replacing a long string with a short one adds delta size instead of subtracting.
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
}))

describe('BUG: room state size estimation grows monotonically', () => {
  let manager: LiveRoomManager

  beforeEach(async () => {
    manager = new LiveRoomManager(new RoomEventBus())
    const ws = createMockWS()
    await manager.joinRoom('comp-1', 'test-room', ws, {
      longField: 'x'.repeat(1000),
      counter: 0,
    })
  })

  it('should not overestimate size when replacing a long value with a short one', () => {
    // Initial state has longField = 'x' * 1000
    // After this update, longField = 'y' (much shorter)
    manager.setRoomState('test-room', { longField: 'y' })

    const state = manager.getRoomState('test-room')
    const actualSize = JSON.stringify(state).length

    // The real state is now small (~30 bytes)
    expect(actualSize).toBeLessThan(100)

    // Now do another small update. If stateSize is wildly overestimated,
    // this might falsely trigger the size limit check.
    // The estimated size should be close to actual, not 1000+ bytes off.
    expect(() => {
      manager.setRoomState('test-room', { counter: 1 })
    }).not.toThrow()
  })

  it('should track size accurately after many shrinking updates', () => {
    // Repeatedly replace the long field with shorter values
    for (let i = 0; i < 50; i++) {
      manager.setRoomState('test-room', { longField: `v${i}` })
    }

    const state = manager.getRoomState('test-room')
    const actualSize = JSON.stringify(state).length

    // After 50 updates replacing longField, the internal estimate should be
    // reasonably close to the actual size, not inflated by 50 * delta_size.
    //
    // BUG: stateSize += deltaSize for each update. Each delta is ~15 bytes,
    // so after 50 updates the estimate is ~1000 + 50*15 = 1750 bytes,
    // but the actual state is only ~40 bytes.
    //
    // The re-check at MAX_ROOM_STATE_SIZE threshold corrects it, but
    // the estimate drifts significantly between re-checks.

    // We can't directly access room.stateSize, but we can verify
    // the system doesn't reject reasonable state updates
    expect(actualSize).toBeLessThan(100)
    expect(() => {
      manager.setRoomState('test-room', { counter: 999 })
    }).not.toThrow()
  })

  it('should not falsely reject updates due to inflated size estimate', async () => {
    // Create a room near the size limit
    const ws = createMockWS()
    const bigInitial = { data: 'x'.repeat(5 * 1024 * 1024) } // 5MB
    await manager.joinRoom('comp-2', 'big-room', ws, bigInitial)

    // Shrink it way down
    manager.setRoomState('big-room', { data: 'small' })

    // Now the actual state is tiny, but the internal estimate might still
    // think it's ~5MB + delta. Another update should NOT throw.
    // BUG: The estimate is 5MB + sizeof('small'), which is way over actual.
    // If we add more data, it might falsely exceed the limit.
    expect(() => {
      manager.setRoomState('big-room', { extra: 'y'.repeat(1000) })
    }).not.toThrow()
  })
})
