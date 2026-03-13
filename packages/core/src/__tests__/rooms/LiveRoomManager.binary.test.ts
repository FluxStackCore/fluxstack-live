// Tests for LiveRoomManager — binary broadcast path (codec system)
//
// Validates that:
// - LiveRoom-backed rooms use binary msgpack broadcast (default)
// - Legacy rooms use JSON text broadcast with serialize-once
// - Codec option 'json' sends binary JSON frames
// - Custom codecs are respected
// - Frame format is correct and parseable

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LiveRoomManager } from '../../rooms/LiveRoomManager'
import { RoomEventBus } from '../../rooms/RoomEventBus'
import { LiveRoom } from '../../rooms/LiveRoom'
import { RoomRegistry } from '../../rooms/RoomRegistry'
import { createMockWS } from '../helpers'
import { msgpackCodec, jsonCodec, parseRoomFrame, BINARY_ROOM_EVENT, BINARY_ROOM_STATE } from '../../rooms/RoomCodec'

// Mock the WsSendBatcher
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

import { queuePreSerialized, sendBinaryImmediate } from '../../transport/WsSendBatcher'

// ===== Test Room Classes =====

class CounterRoom extends LiveRoom<{ count: number }, {}, { 'counter:updated': { count: number } }> {
  static roomName = 'counter'
  static defaultState = { count: 0 }
  static defaultMeta = {}
  // No $options → default codec = msgpack
}

class JsonRoom extends LiveRoom<{ value: string }, {}, {}> {
  static roomName = 'jsonroom'
  static defaultState = { value: '' }
  static defaultMeta = {}
  static $options = { codec: 'json' as const }
}

class CustomCodecRoom extends LiveRoom<{ data: number }, {}, {}> {
  static roomName = 'custom'
  static defaultState = { data: 0 }
  static defaultMeta = {}
  static $options = {
    codec: {
      encode: (data: unknown) => new TextEncoder().encode(`CUSTOM:${JSON.stringify(data)}`),
      decode: (buf: Uint8Array) => {
        const text = new TextDecoder().decode(buf)
        return JSON.parse(text.replace('CUSTOM:', ''))
      },
    },
  }
}

// ===== Tests =====

describe('LiveRoomManager binary broadcast', () => {
  let roomEvents: RoomEventBus
  let manager: LiveRoomManager
  let registry: RoomRegistry

  beforeEach(() => {
    roomEvents = new RoomEventBus()
    manager = new LiveRoomManager(roomEvents)
    registry = new RoomRegistry()
    manager.roomRegistry = registry
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('LiveRoom-backed rooms (binary msgpack by default)', () => {
    beforeEach(() => {
      registry.register(CounterRoom as any)
    })

    it('uses sendBinaryImmediate for emitToRoom', () => {
      const ws1 = createMockWS()
      const ws2 = createMockWS()
      manager.joinRoom('comp-1', 'counter:global', ws1)
      manager.joinRoom('comp-2', 'counter:global', ws2)

      vi.clearAllMocks()
      manager.emitToRoom('counter:global', 'counter:updated', { count: 42 })

      // Should use binary path, not JSON
      expect(sendBinaryImmediate).toHaveBeenCalledTimes(2)
      expect(queuePreSerialized).not.toHaveBeenCalled()
    })

    it('sends parseable binary ROOM_EVENT frames', () => {
      const ws1 = createMockWS()
      const ws2 = createMockWS()
      manager.joinRoom('comp-1', 'counter:global', ws1)
      manager.joinRoom('comp-2', 'counter:global', ws2)

      vi.clearAllMocks()
      manager.emitToRoom('counter:global', 'counter:updated', { count: 10, updatedBy: 'Alice' })

      // Parse frame sent to comp-1
      const call1 = (sendBinaryImmediate as any).mock.calls[0]
      const frame1 = call1[1] as Uint8Array
      const parsed1 = parseRoomFrame(frame1)

      expect(parsed1).not.toBeNull()
      expect(parsed1!.frameType).toBe(BINARY_ROOM_EVENT)
      expect(parsed1!.componentId).toBe('comp-1')
      expect(parsed1!.roomId).toBe('counter:global')
      expect(parsed1!.event).toBe('counter:updated')

      const data1 = msgpackCodec.decode(parsed1!.payload)
      expect(data1).toEqual({ count: 10, updatedBy: 'Alice' })

      // Parse frame sent to comp-2
      const call2 = (sendBinaryImmediate as any).mock.calls[1]
      const parsed2 = parseRoomFrame(call2[1] as Uint8Array)
      expect(parsed2!.componentId).toBe('comp-2')
    })

    it('uses sendBinaryImmediate for setRoomState', () => {
      const ws1 = createMockWS()
      manager.joinRoom('comp-1', 'counter:global', ws1)

      vi.clearAllMocks()
      manager.setRoomState('counter:global', { count: 5 })

      expect(sendBinaryImmediate).toHaveBeenCalledTimes(1)
      expect(queuePreSerialized).not.toHaveBeenCalled()
    })

    it('sends parseable binary ROOM_STATE frames', () => {
      const ws1 = createMockWS()
      manager.joinRoom('comp-1', 'counter:global', ws1)

      vi.clearAllMocks()
      manager.setRoomState('counter:global', { count: 99 })

      const call = (sendBinaryImmediate as any).mock.calls[0]
      const parsed = parseRoomFrame(call[1] as Uint8Array)

      expect(parsed!.frameType).toBe(BINARY_ROOM_STATE)
      expect(parsed!.componentId).toBe('comp-1')
      expect(parsed!.roomId).toBe('counter:global')

      const data = msgpackCodec.decode(parsed!.payload)
      expect(data).toEqual({ state: { count: 99 } })
    })

    it('respects excludeComponentId in binary broadcast', () => {
      const ws1 = createMockWS()
      const ws2 = createMockWS()
      manager.joinRoom('comp-1', 'counter:global', ws1)
      manager.joinRoom('comp-2', 'counter:global', ws2)

      vi.clearAllMocks()
      manager.emitToRoom('counter:global', 'counter:updated', { count: 1 }, 'comp-1')

      // Only comp-2 should receive the frame
      expect(sendBinaryImmediate).toHaveBeenCalledTimes(1)
      const parsed = parseRoomFrame((sendBinaryImmediate as any).mock.calls[0][1])
      expect(parsed!.componentId).toBe('comp-2')
    })

    it('builds tail once and prepends per-member header', () => {
      const ws1 = createMockWS()
      const ws2 = createMockWS()
      const ws3 = createMockWS()
      manager.joinRoom('comp-1', 'counter:global', ws1)
      manager.joinRoom('comp-2', 'counter:global', ws2)
      manager.joinRoom('comp-3', 'counter:global', ws3)

      vi.clearAllMocks()
      manager.emitToRoom('counter:global', 'counter:updated', { count: 77 })

      expect(sendBinaryImmediate).toHaveBeenCalledTimes(3)

      // All frames should have same roomId, event, and payload — only componentId differs
      const parsedFrames = (sendBinaryImmediate as any).mock.calls.map(
        (c: any) => parseRoomFrame(c[1])
      )

      const compIds = parsedFrames.map((p: any) => p.componentId).sort()
      expect(compIds).toEqual(['comp-1', 'comp-2', 'comp-3'])

      // All should decode to the same payload
      for (const parsed of parsedFrames) {
        expect(parsed.roomId).toBe('counter:global')
        expect(parsed.event).toBe('counter:updated')
        expect(msgpackCodec.decode(parsed.payload)).toEqual({ count: 77 })
      }
    })
  })

  describe('Legacy rooms (JSON text mode)', () => {
    it('uses queuePreSerialized for legacy rooms', () => {
      const ws1 = createMockWS()
      const ws2 = createMockWS()
      manager.joinRoom('comp-1', 'legacy:room', ws1, { msg: '' })
      manager.joinRoom('comp-2', 'legacy:room', ws2)

      vi.clearAllMocks()
      manager.emitToRoom('legacy:room', 'chat:msg', { text: 'hello' })

      // Should use JSON path, not binary
      expect(queuePreSerialized).toHaveBeenCalledTimes(2)
      expect(sendBinaryImmediate).not.toHaveBeenCalled()
    })

    it('serializes JSON once and splices componentId per member', () => {
      const ws1 = createMockWS()
      const ws2 = createMockWS()
      manager.joinRoom('comp-1', 'legacy:room', ws1, {})
      manager.joinRoom('comp-2', 'legacy:room', ws2)

      vi.clearAllMocks()
      manager.emitToRoom('legacy:room', 'event:x', { data: 'shared' })

      // Both calls should produce valid JSON with correct componentId
      for (const call of (queuePreSerialized as any).mock.calls) {
        const json = call[1]
        const parsed = JSON.parse(json)
        expect(['comp-1', 'comp-2']).toContain(parsed.componentId)
        expect(parsed.type).toBe('ROOM_EVENT')
        expect(parsed.roomId).toBe('legacy:room')
        expect(parsed.event).toBe('event:x')
        expect(parsed.data).toEqual({ data: 'shared' })
      }

      // Verify different componentIds
      const ids = (queuePreSerialized as any).mock.calls.map(
        (c: any) => JSON.parse(c[1]).componentId
      )
      expect(ids.sort()).toEqual(['comp-1', 'comp-2'])
    })
  })

  describe('LiveRoom with codec: "json"', () => {
    beforeEach(() => {
      registry.register(JsonRoom as any)
    })

    it('uses binary path with JSON codec', () => {
      const ws1 = createMockWS()
      manager.joinRoom('comp-1', 'jsonroom:test', ws1)

      vi.clearAllMocks()
      manager.setRoomState('jsonroom:test', { value: 'updated' })

      expect(sendBinaryImmediate).toHaveBeenCalledTimes(1)

      const parsed = parseRoomFrame((sendBinaryImmediate as any).mock.calls[0][1])
      expect(parsed).not.toBeNull()

      // Payload should be JSON-encoded (UTF-8 text)
      const payloadText = new TextDecoder().decode(parsed!.payload)
      const data = JSON.parse(payloadText)
      expect(data).toEqual({ state: { value: 'updated' } })
    })
  })

  describe('LiveRoom with custom codec', () => {
    beforeEach(() => {
      registry.register(CustomCodecRoom as any)
    })

    it('uses custom codec for encoding', () => {
      const ws1 = createMockWS()
      manager.joinRoom('comp-1', 'custom:test', ws1)

      vi.clearAllMocks()
      manager.emitToRoom('custom:test', 'event', { data: 42 })

      expect(sendBinaryImmediate).toHaveBeenCalledTimes(1)

      const parsed = parseRoomFrame((sendBinaryImmediate as any).mock.calls[0][1])
      expect(parsed).not.toBeNull()

      // Payload should have CUSTOM: prefix
      const payloadText = new TextDecoder().decode(parsed!.payload)
      expect(payloadText.startsWith('CUSTOM:')).toBe(true)

      // Decode with the same custom codec
      const decoded = CustomCodecRoom.$options.codec.decode(parsed!.payload)
      expect(decoded).toEqual({ data: 42 })
    })
  })

  describe('broadcast skips closed connections', () => {
    it('skips WS with readyState !== 1', () => {
      const wsOpen = createMockWS()
      const wsClosed = { ...createMockWS(), readyState: 3 } as any

      registry.register(CounterRoom as any)
      manager.joinRoom('comp-1', 'counter:test', wsOpen)
      manager.joinRoom('comp-2', 'counter:test', wsClosed)

      vi.clearAllMocks()
      const sent = manager.emitToRoom('counter:test', 'evt', {})

      expect(sent).toBe(1)
      expect(sendBinaryImmediate).toHaveBeenCalledTimes(1)
    })
  })
})
