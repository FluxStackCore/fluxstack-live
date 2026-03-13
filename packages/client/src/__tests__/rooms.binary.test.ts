// Tests for client-side binary room frame handling
//
// Validates that the RoomManager correctly:
// - Parses binary room frames (0x02 ROOM_EVENT, 0x03 ROOM_STATE)
// - Decodes msgpack payloads
// - Dispatches to event handlers
// - Merges state updates

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RoomManager } from '../rooms'
import type { RoomServerMessage } from '../rooms'

// ===== Helpers: build binary frames matching server format =====

const encoder = new TextEncoder()

// Minimal msgpack encoder (matches server output) — only what we need for tests
function msgpackEncode(value: unknown): Uint8Array {
  const parts: Uint8Array[] = []
  _encode(value, parts)
  let total = 0
  for (const p of parts) total += p.length
  const result = new Uint8Array(total)
  let off = 0
  for (const p of parts) { result.set(p, off); off += p.length }
  return result
}

function _encode(value: unknown, parts: Uint8Array[]): void {
  if (value === null || value === undefined) { parts.push(new Uint8Array([0xc0])); return }
  if (typeof value === 'boolean') { parts.push(new Uint8Array([value ? 0xc3 : 0xc2])); return }
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= 0 && value < 128) {
      parts.push(new Uint8Array([value])); return
    }
    if (Number.isInteger(value) && value >= -32 && value < 0) {
      parts.push(new Uint8Array([value & 0xff])); return
    }
    // float64
    const buf = new Uint8Array(9); buf[0] = 0xcb
    new DataView(buf.buffer).setFloat64(1, value, false)
    parts.push(buf); return
  }
  if (typeof value === 'string') {
    const encoded = encoder.encode(value)
    if (encoded.length < 32) parts.push(new Uint8Array([0xa0 | encoded.length]))
    else { parts.push(new Uint8Array([0xd9, encoded.length])) }
    parts.push(encoded); return
  }
  if (Array.isArray(value)) {
    if (value.length < 16) parts.push(new Uint8Array([0x90 | value.length]))
    else parts.push(new Uint8Array([0xdc, value.length >> 8, value.length & 0xff]))
    for (const item of value) _encode(item, parts)
    return
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>)
    if (keys.length < 16) parts.push(new Uint8Array([0x80 | keys.length]))
    else parts.push(new Uint8Array([0xde, keys.length >> 8, keys.length & 0xff]))
    for (const key of keys) { _encode(key, parts); _encode((value as any)[key], parts) }
    return
  }
  parts.push(new Uint8Array([0xc0]))
}

/** Build a binary room frame matching the server's wire format */
function buildTestFrame(
  frameType: number,
  componentId: string,
  roomId: string,
  event: string,
  data: unknown,
): Uint8Array {
  const compIdBytes = encoder.encode(componentId)
  const roomIdBytes = encoder.encode(roomId)
  const eventBytes = encoder.encode(event)
  const payload = msgpackEncode(data)

  const totalLen = 1 + 1 + compIdBytes.length + 1 + roomIdBytes.length + 2 + eventBytes.length + payload.length
  const frame = new Uint8Array(totalLen)
  let offset = 0

  frame[offset++] = frameType
  frame[offset++] = compIdBytes.length
  frame.set(compIdBytes, offset); offset += compIdBytes.length
  frame[offset++] = roomIdBytes.length
  frame.set(roomIdBytes, offset); offset += roomIdBytes.length
  frame[offset++] = (eventBytes.length >> 8) & 0xff
  frame[offset++] = eventBytes.length & 0xff
  frame.set(eventBytes, offset); offset += eventBytes.length
  frame.set(payload, offset)

  return frame
}

const BINARY_ROOM_EVENT = 0x02
const BINARY_ROOM_STATE = 0x03

// ===== RoomManager binary frame tests =====

describe('RoomManager binary frame handling', () => {
  let manager: RoomManager
  let binaryHandler: ((frame: Uint8Array) => void) | null
  let jsonHandlers: Set<(msg: RoomServerMessage) => void>

  beforeEach(() => {
    binaryHandler = null
    jsonHandlers = new Set()

    manager = new RoomManager({
      componentId: 'comp-test-1',
      sendMessage: vi.fn(),
      sendMessageAndWait: vi.fn().mockResolvedValue({ success: true, state: {} }),
      onMessage: (handler) => {
        jsonHandlers.add(handler)
        return () => { jsonHandlers.delete(handler) }
      },
      onBinaryMessage: (handler) => {
        binaryHandler = handler
        return () => { binaryHandler = null }
      },
    })
  })

  // Helper: join a room via JSON so the room exists in the manager
  function joinRoom(roomId: string, initialState: any = {}) {
    // Simulate the join by sending a JSON ROOM_JOINED message
    const handle = manager.createHandle(roomId)
    // Manually trigger ROOM_JOINED via JSON handler
    for (const handler of jsonHandlers) {
      handler({
        type: 'ROOM_JOINED',
        componentId: 'comp-test-1',
        roomId,
        event: '$room:joined',
        data: { state: initialState },
        timestamp: Date.now(),
      })
    }
    return handle
  }

  describe('BINARY_ROOM_EVENT (0x02)', () => {
    it('dispatches binary event to room handler', () => {
      const handle = joinRoom('counter:global')
      const eventHandler = vi.fn()
      handle.on('counter:updated' as any, eventHandler)

      // Send binary room event frame
      const frame = buildTestFrame(BINARY_ROOM_EVENT, 'comp-test-1', 'counter:global', 'counter:updated', {
        count: 42,
        updatedBy: 'Alice',
      })
      binaryHandler!(frame)

      expect(eventHandler).toHaveBeenCalledTimes(1)
      expect(eventHandler).toHaveBeenCalledWith({ count: 42, updatedBy: 'Alice' })
    })

    it('ignores events for different componentId', () => {
      const handle = joinRoom('counter:global')
      const eventHandler = vi.fn()
      handle.on('counter:updated' as any, eventHandler)

      const frame = buildTestFrame(BINARY_ROOM_EVENT, 'comp-other', 'counter:global', 'counter:updated', { count: 1 })
      binaryHandler!(frame)

      expect(eventHandler).not.toHaveBeenCalled()
    })

    it('ignores events for non-existent room', () => {
      // Don't join any room
      const frame = buildTestFrame(BINARY_ROOM_EVENT, 'comp-test-1', 'unknown:room', 'some-event', {})
      // Should not throw
      binaryHandler!(frame)
    })

    it('dispatches to multiple handlers', () => {
      const handle = joinRoom('game:room')
      const handler1 = vi.fn()
      const handler2 = vi.fn()
      handle.on('score:updated' as any, handler1)
      handle.on('score:updated' as any, handler2)

      const frame = buildTestFrame(BINARY_ROOM_EVENT, 'comp-test-1', 'game:room', 'score:updated', { score: 100 })
      binaryHandler!(frame)

      expect(handler1).toHaveBeenCalledWith({ score: 100 })
      expect(handler2).toHaveBeenCalledWith({ score: 100 })
    })

    it('handles handler errors without breaking other handlers', () => {
      const handle = joinRoom('room:a')
      const errorHandler = vi.fn(() => { throw new Error('test error') })
      const goodHandler = vi.fn()
      handle.on('evt' as any, errorHandler)
      handle.on('evt' as any, goodHandler)

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const frame = buildTestFrame(BINARY_ROOM_EVENT, 'comp-test-1', 'room:a', 'evt', { x: 1 })
      binaryHandler!(frame)

      expect(errorHandler).toHaveBeenCalled()
      expect(goodHandler).toHaveBeenCalledWith({ x: 1 })
      expect(consoleSpy).toHaveBeenCalled()

      consoleSpy.mockRestore()
    })
  })

  describe('BINARY_ROOM_STATE (0x03)', () => {
    it('merges state update into room state', () => {
      const handle = joinRoom('counter:global', { count: 0, onlineCount: 1, lastUpdatedBy: null })

      const frame = buildTestFrame(BINARY_ROOM_STATE, 'comp-test-1', 'counter:global', '$state:update', {
        state: { count: 42, lastUpdatedBy: 'Bob' },
      })
      binaryHandler!(frame)

      expect(handle.state).toEqual({ count: 42, onlineCount: 1, lastUpdatedBy: 'Bob' })
    })

    it('triggers $state:change handlers', () => {
      const handle = joinRoom('counter:global', { count: 0 })
      const stateHandler = vi.fn()
      // Internal event for state change
      handle.on('$state:change' as any, stateHandler)

      const frame = buildTestFrame(BINARY_ROOM_STATE, 'comp-test-1', 'counter:global', '$state:update', {
        state: { count: 10 },
      })
      binaryHandler!(frame)

      expect(stateHandler).toHaveBeenCalledWith({ count: 10 })
    })

    it('handles state without wrapper (data is the state directly)', () => {
      const handle = joinRoom('room:x', { val: 0 })

      // Some code paths send data directly without { state: ... } wrapper
      const frame = buildTestFrame(BINARY_ROOM_STATE, 'comp-test-1', 'room:x', '$state:update', { val: 99 })
      binaryHandler!(frame)

      expect(handle.state).toEqual({ val: 99 })
    })

    it('deep merges nested state', () => {
      const handle = joinRoom('game:1', {
        players: { alice: { score: 10 } },
        round: 1,
      })

      const frame = buildTestFrame(BINARY_ROOM_STATE, 'comp-test-1', 'game:1', '$state:update', {
        state: { players: { alice: { score: 20 } } },
      })
      binaryHandler!(frame)

      expect(handle.state).toEqual({
        players: { alice: { score: 20 } },
        round: 1,
      })
    })
  })

  describe('mixed binary + JSON', () => {
    it('handles both binary and JSON messages for the same room', () => {
      const handle = joinRoom('counter:global', { count: 0 })
      const eventHandler = vi.fn()
      handle.on('counter:updated' as any, eventHandler)

      // Binary event
      binaryHandler!(buildTestFrame(BINARY_ROOM_EVENT, 'comp-test-1', 'counter:global', 'counter:updated', { count: 1, updatedBy: 'Alice' }))

      // JSON event
      for (const handler of jsonHandlers) {
        handler({
          type: 'ROOM_EVENT',
          componentId: 'comp-test-1',
          roomId: 'counter:global',
          event: 'counter:updated',
          data: { count: 2, updatedBy: 'Bob' },
          timestamp: Date.now(),
        })
      }

      expect(eventHandler).toHaveBeenCalledTimes(2)
      expect(eventHandler).toHaveBeenNthCalledWith(1, { count: 1, updatedBy: 'Alice' })
      expect(eventHandler).toHaveBeenNthCalledWith(2, { count: 2, updatedBy: 'Bob' })
    })
  })

  describe('complex msgpack payloads', () => {
    it('decodes arrays in binary events', () => {
      const handle = joinRoom('chat:lobby')
      const handler = vi.fn()
      handle.on('messages:batch' as any, handler)

      const messages = [
        { id: 1, text: 'hello', user: 'alice' },
        { id: 2, text: 'world', user: 'bob' },
      ]
      binaryHandler!(buildTestFrame(BINARY_ROOM_EVENT, 'comp-test-1', 'chat:lobby', 'messages:batch', messages))

      expect(handler).toHaveBeenCalledWith(messages)
    })

    it('decodes nested objects in binary state updates', () => {
      const handle = joinRoom('game:complex', {
        board: { cells: [] },
        players: {},
      })

      const stateUpdate = {
        state: {
          board: { cells: [[1, 0], [0, 2]] },
          players: {
            p1: { name: 'Alice', score: 100, items: ['sword'] },
          },
        },
      }
      binaryHandler!(buildTestFrame(BINARY_ROOM_STATE, 'comp-test-1', 'game:complex', '$state:update', stateUpdate))

      expect(handle.state.board.cells).toEqual([[1, 0], [0, 2]])
      expect(handle.state.players.p1.name).toBe('Alice')
      expect(handle.state.players.p1.items).toEqual(['sword'])
    })

    it('decodes boolean and null values correctly', () => {
      const handle = joinRoom('room:types')
      const handler = vi.fn()
      handle.on('data:typed' as any, handler)

      binaryHandler!(buildTestFrame(BINARY_ROOM_EVENT, 'comp-test-1', 'room:types', 'data:typed', {
        active: true,
        deleted: false,
        metadata: null,
        count: 0,
        name: '',
      }))

      expect(handler).toHaveBeenCalledWith({
        active: true,
        deleted: false,
        metadata: null,
        count: 0,
        name: '',
      })
    })
  })

  describe('cleanup', () => {
    it('unsubscribes binary handler on destroy', () => {
      expect(binaryHandler).not.toBeNull()
      manager.destroy()
      expect(binaryHandler).toBeNull()
    })
  })
})
