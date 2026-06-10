// BUG: LiveServer.handleClose was passing connectionId to roomManager.cleanupComponent
// instead of iterating ws.data.components and cleaning each componentId.
// This test verifies the correct behavior after the fix.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LiveRoomManager } from '../../rooms/LiveRoomManager'
import { RoomEventBus } from '../../rooms/RoomEventBus'
import { createMockWS } from '../helpers'

vi.mock('../../transport/WsSendBatcher', () => ({
  queueWsMessage: vi.fn(),
  queuePreSerialized: vi.fn(),
  sendImmediate: vi.fn(),
  setResyncHandler: vi.fn(),
  sendBinaryImmediate: vi.fn(),
}))

vi.mock('../../debug/LiveLogger', () => ({
  liveLog: vi.fn(),
  liveWarn: vi.fn(),
}))

describe('handleClose room cleanup — connectionId vs componentId', () => {
  let manager: LiveRoomManager

  beforeEach(() => {
    vi.useFakeTimers()
    manager = new LiveRoomManager(new RoomEventBus())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('cleanupComponent with connectionId is a no-op (rooms use componentId)', async () => {
    const ws = createMockWS()
    const connectionId = ws.data.connectionId

    await manager.joinRoom('comp-1', 'chat:lobby', ws)
    expect(manager.isInRoom('comp-1', 'chat:lobby')).toBe(true)

    // This is the OLD bug: calling cleanupComponent with connectionId does nothing
    await manager.cleanupComponent(connectionId)

    // Component is still in room — connectionId is not a valid key
    expect(manager.isInRoom('comp-1', 'chat:lobby')).toBe(true)
  })

  it('cleanupComponent with componentId correctly cleans rooms', async () => {
    const ws = createMockWS()

    await manager.joinRoom('comp-1', 'chat:lobby', ws)
    expect(manager.isInRoom('comp-1', 'chat:lobby')).toBe(true)

    // FIX: LiveServer.handleClose now iterates ws.data.components.keys()
    // and calls cleanupComponent with each componentId
    await manager.cleanupComponent('comp-1')
    expect(manager.isInRoom('comp-1', 'chat:lobby')).toBe(false)
  })

  it('simulates the fixed handleClose flow — cleanup per componentId', async () => {
    const ws = createMockWS()

    // Multiple components on same connection
    await manager.joinRoom('comp-1', 'room-a', ws)
    await manager.joinRoom('comp-2', 'room-b', ws)
    await manager.joinRoom('comp-3', 'room-a', ws)

    expect(manager.isInRoom('comp-1', 'room-a')).toBe(true)
    expect(manager.isInRoom('comp-2', 'room-b')).toBe(true)
    expect(manager.isInRoom('comp-3', 'room-a')).toBe(true)

    // Simulate the FIXED handleClose: iterate each componentId
    const componentIds = ['comp-1', 'comp-2', 'comp-3']
    for (const componentId of componentIds) {
      await manager.cleanupComponent(componentId)
    }

    expect(manager.isInRoom('comp-1', 'room-a')).toBe(false)
    expect(manager.isInRoom('comp-2', 'room-b')).toBe(false)
    expect(manager.isInRoom('comp-3', 'room-a')).toBe(false)
  })
})
