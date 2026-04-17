// Regression tests for issue #28:
// "refactor(client): move room handlers out of this.rooms to decouple from lifecycle"
//
// Covers the new semantics introduced in v0.9.0:
//   - `destroy()` PRESERVES consumer handlers (this.roomHandlers survives)
//   - `leave()` only flips joined state; does NOT wipe handlers
//   - `disposeRoom(roomId)` explicitly drops all state + handlers for a room
//   - `disposeAll()` wipes everything (terminal)
//   - `handle.removeAllListeners(event?)` gives consumers fine-grained control
//
// The previous behavior (destroy/leave both called `room.handlers.clear()`)
// was the root cause of issue #27 — React effects registering handlers and
// losing them silently across remounts and reconnects.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RoomManager } from '../rooms'
import type { RoomServerMessage } from '../rooms'

// ===== Binary frame helpers (same as rooms.binary.test.ts) =====

const encoder = new TextEncoder()

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
    const buf = new Uint8Array(9); buf[0] = 0xcb
    new DataView(buf.buffer).setFloat64(1, value, false)
    parts.push(buf); return
  }
  if (typeof value === 'string') {
    const bytes = encoder.encode(value)
    if (bytes.length < 32) parts.push(new Uint8Array([0xa0 | bytes.length]))
    else parts.push(new Uint8Array([0xd9, bytes.length]))
    parts.push(bytes); return
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

function buildFrame(
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

// ===== Transport harness =====

interface Transport {
  jsonHandlers: Set<(msg: RoomServerMessage) => void>
  binaryHandlers: Set<(frame: Uint8Array) => void>
  makeManager(componentId: string): RoomManager
  emitBinary(frame: Uint8Array): void
  emitJson(msg: RoomServerMessage): void
}

function createTransport(): Transport {
  const jsonHandlers = new Set<(msg: RoomServerMessage) => void>()
  const binaryHandlers = new Set<(frame: Uint8Array) => void>()
  return {
    jsonHandlers,
    binaryHandlers,
    makeManager(componentId: string) {
      return new RoomManager({
        componentId,
        sendMessage: vi.fn(),
        sendMessageAndWait: vi.fn().mockResolvedValue({ success: true, state: {} }),
        onMessage: (h) => { jsonHandlers.add(h); return () => { jsonHandlers.delete(h) } },
        onBinaryMessage: (h) => { binaryHandlers.add(h); return () => { binaryHandlers.delete(h) } },
      })
    },
    emitBinary(frame) { for (const h of binaryHandlers) h(frame) },
    emitJson(msg) { for (const h of jsonHandlers) h(msg) },
  }
}

function joinRoom(
  manager: RoomManager,
  transport: Transport,
  componentId: string,
  roomId: string,
  initialState: any = {},
) {
  const handle = manager.createHandle(roomId)
  transport.emitJson({
    type: 'ROOM_JOINED',
    componentId,
    roomId,
    event: '$room:joined',
    data: { state: initialState },
    timestamp: Date.now(),
  })
  return handle
}

// ===============================================================
// TESTS
// ===============================================================

describe('Issue #28: handlers decoupled from room lifecycle', () => {
  let transport: Transport
  const COMP_ID = 'c1'
  const ROOM_ID = 'game:1'

  beforeEach(() => { transport = createTransport() })

  // --------------------------------------------------------------
  //  destroy() no longer wipes handlers
  // --------------------------------------------------------------
  describe('destroy() preserves consumer handlers', () => {
    it('on() handler registered before destroy fires after resubscribe + re-join', () => {
      const mgr = transport.makeManager(COMP_ID)
      const handle = joinRoom(mgr, transport, COMP_ID, ROOM_ID, { score: 0 })
      const handler = vi.fn()
      handle.on('score:updated' as any, handler)

      mgr.destroy()
      mgr.resubscribe()
      joinRoom(mgr, transport, COMP_ID, ROOM_ID, { score: 0 })

      transport.emitBinary(buildFrame(BINARY_ROOM_EVENT, COMP_ID, ROOM_ID, 'score:updated', { score: 42 }))

      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith({ score: 42 })
    })

    it('onSystem state:change handler registered before destroy fires after re-join', () => {
      const mgr = transport.makeManager(COMP_ID)
      const handle = joinRoom(mgr, transport, COMP_ID, ROOM_ID, { score: 0 })
      const handler = vi.fn()
      handle.onSystem('state:change', handler)

      mgr.destroy()
      mgr.resubscribe()
      joinRoom(mgr, transport, COMP_ID, ROOM_ID, { score: 0 })

      transport.emitBinary(buildFrame(BINARY_ROOM_STATE, COMP_ID, ROOM_ID, '$state:update', {
        state: { score: 100 },
      }))

      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith({ score: 100 })
    })

    it('handlers survive multiple destroy/resubscribe cycles', () => {
      const mgr = transport.makeManager(COMP_ID)
      const handle = joinRoom(mgr, transport, COMP_ID, ROOM_ID, { n: 0 })
      const handler = vi.fn()
      handle.on('tick' as any, handler)

      for (let i = 0; i < 3; i++) {
        mgr.destroy()
        mgr.resubscribe()
        joinRoom(mgr, transport, COMP_ID, ROOM_ID, { n: 0 })
      }

      transport.emitBinary(buildFrame(BINARY_ROOM_EVENT, COMP_ID, ROOM_ID, 'tick', { i: 1 }))
      transport.emitBinary(buildFrame(BINARY_ROOM_EVENT, COMP_ID, ROOM_ID, 'tick', { i: 2 }))

      expect(handler).toHaveBeenCalledTimes(2)
    })
  })

  // --------------------------------------------------------------
  //  leave() no longer wipes handlers
  // --------------------------------------------------------------
  describe('leave() preserves handlers', () => {
    it('handler registered before leave fires again after rejoin', async () => {
      const mgr = transport.makeManager(COMP_ID)
      const handle = joinRoom(mgr, transport, COMP_ID, ROOM_ID, { score: 0 })
      const handler = vi.fn()
      handle.on('score:updated' as any, handler)

      await handle.leave()
      // Emit while left — no room entry is gone yet, handler still registered.
      // Server won't send events while we're left, but if it did we'd still
      // skip them because room.joined is false. Simulate a rejoin:
      joinRoom(mgr, transport, COMP_ID, ROOM_ID, { score: 0 })

      transport.emitBinary(buildFrame(BINARY_ROOM_EVENT, COMP_ID, ROOM_ID, 'score:updated', { score: 7 }))

      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith({ score: 7 })
    })
  })

  // --------------------------------------------------------------
  //  disposeRoom() — explicit opt-in cleanup
  // --------------------------------------------------------------
  describe('disposeRoom(roomId) drops all state and handlers', () => {
    it('handlers registered for that room no longer fire after disposeRoom', () => {
      const mgr = transport.makeManager(COMP_ID)
      const handle = joinRoom(mgr, transport, COMP_ID, ROOM_ID, { score: 0 })
      const handler = vi.fn()
      handle.on('score:updated' as any, handler)

      mgr.disposeRoom(ROOM_ID)

      // Rejoin — room entry is recreated, but handlers are gone.
      joinRoom(mgr, transport, COMP_ID, ROOM_ID, { score: 0 })
      transport.emitBinary(buildFrame(BINARY_ROOM_EVENT, COMP_ID, ROOM_ID, 'score:updated', { score: 1 }))

      expect(handler).not.toHaveBeenCalled()
    })

    it('disposeRoom only affects the target room, leaving others intact', () => {
      const mgr = transport.makeManager(COMP_ID)
      const handleA = joinRoom(mgr, transport, COMP_ID, 'room:a', {})
      const handleB = joinRoom(mgr, transport, COMP_ID, 'room:b', {})
      const handlerA = vi.fn()
      const handlerB = vi.fn()
      handleA.on('evt' as any, handlerA)
      handleB.on('evt' as any, handlerB)

      mgr.disposeRoom('room:a')

      // room:b should still work end-to-end without needing rejoin.
      transport.emitBinary(buildFrame(BINARY_ROOM_EVENT, COMP_ID, 'room:b', 'evt', { x: 1 }))

      expect(handlerA).not.toHaveBeenCalled()
      expect(handlerB).toHaveBeenCalledTimes(1)
    })
  })

  // --------------------------------------------------------------
  //  removeAllListeners — fine-grained consumer cleanup
  // --------------------------------------------------------------
  describe('handle.removeAllListeners()', () => {
    it('removes all handlers for a specific event', () => {
      const mgr = transport.makeManager(COMP_ID)
      const handle = joinRoom(mgr, transport, COMP_ID, ROOM_ID, {})
      const h1 = vi.fn()
      const h2 = vi.fn()
      const other = vi.fn()
      handle.on('evt' as any, h1)
      handle.on('evt' as any, h2)
      handle.on('other' as any, other)

      handle.removeAllListeners('evt')

      transport.emitBinary(buildFrame(BINARY_ROOM_EVENT, COMP_ID, ROOM_ID, 'evt', { x: 1 }))
      transport.emitBinary(buildFrame(BINARY_ROOM_EVENT, COMP_ID, ROOM_ID, 'other', { x: 2 }))

      expect(h1).not.toHaveBeenCalled()
      expect(h2).not.toHaveBeenCalled()
      expect(other).toHaveBeenCalledTimes(1)
    })

    it('removes all handlers across all events when called without an argument', () => {
      const mgr = transport.makeManager(COMP_ID)
      const handle = joinRoom(mgr, transport, COMP_ID, ROOM_ID, {})
      const h1 = vi.fn()
      const h2 = vi.fn()
      const stateHandler = vi.fn()
      handle.on('evt' as any, h1)
      handle.on('other' as any, h2)
      handle.onSystem('state:change', stateHandler)

      handle.removeAllListeners()

      transport.emitBinary(buildFrame(BINARY_ROOM_EVENT, COMP_ID, ROOM_ID, 'evt', { x: 1 }))
      transport.emitBinary(buildFrame(BINARY_ROOM_EVENT, COMP_ID, ROOM_ID, 'other', { x: 2 }))
      transport.emitBinary(buildFrame(BINARY_ROOM_STATE, COMP_ID, ROOM_ID, '$state:update', {
        state: { x: 3 },
      }))

      expect(h1).not.toHaveBeenCalled()
      expect(h2).not.toHaveBeenCalled()
      expect(stateHandler).not.toHaveBeenCalled()
    })

    it('accepts both the plain and prefixed name for system events', () => {
      const mgr = transport.makeManager(COMP_ID)
      const handle = joinRoom(mgr, transport, COMP_ID, ROOM_ID, {})
      const h1 = vi.fn()
      handle.onSystem('state:change', h1)

      // Plain name is the friendlier public form.
      handle.removeAllListeners('state:change')

      transport.emitBinary(buildFrame(BINARY_ROOM_STATE, COMP_ID, ROOM_ID, '$state:update', {
        state: { x: 1 },
      }))
      expect(h1).not.toHaveBeenCalled()
    })
  })

  // --------------------------------------------------------------
  //  Unsubscribe returned by on() still works (unchanged contract)
  // --------------------------------------------------------------
  describe('Unsubscribe returned by on()', () => {
    it('removes only the specific handler that registered it', () => {
      const mgr = transport.makeManager(COMP_ID)
      const handle = joinRoom(mgr, transport, COMP_ID, ROOM_ID, {})
      const h1 = vi.fn()
      const h2 = vi.fn()
      const off1 = handle.on('evt' as any, h1)
      handle.on('evt' as any, h2)

      off1()

      transport.emitBinary(buildFrame(BINARY_ROOM_EVENT, COMP_ID, ROOM_ID, 'evt', { x: 1 }))

      expect(h1).not.toHaveBeenCalled()
      expect(h2).toHaveBeenCalledTimes(1)
    })

    it('still works after destroy()+resubscribe() (the handler survived, so can its unsub)', () => {
      const mgr = transport.makeManager(COMP_ID)
      const handle = joinRoom(mgr, transport, COMP_ID, ROOM_ID, {})
      const handler = vi.fn()
      const off = handle.on('evt' as any, handler)

      mgr.destroy()
      mgr.resubscribe()
      joinRoom(mgr, transport, COMP_ID, ROOM_ID, {})

      // Unsubscribe AFTER the destroy/resubscribe cycle.
      off()

      transport.emitBinary(buildFrame(BINARY_ROOM_EVENT, COMP_ID, ROOM_ID, 'evt', { x: 1 }))

      expect(handler).not.toHaveBeenCalled()
    })
  })

  // --------------------------------------------------------------
  //  disposeAll — terminal cleanup
  // --------------------------------------------------------------
  describe('disposeAll() wipes everything', () => {
    it('drops all handlers across all rooms', () => {
      const mgr = transport.makeManager(COMP_ID)
      const handleA = joinRoom(mgr, transport, COMP_ID, 'room:a', {})
      const handleB = joinRoom(mgr, transport, COMP_ID, 'room:b', {})
      const handlerA = vi.fn()
      const handlerB = vi.fn()
      handleA.on('evt' as any, handlerA)
      handleB.on('evt' as any, handlerB)

      mgr.disposeAll()

      // Transport is disconnected; but even if we tried to emit, handlers
      // are gone from this.roomHandlers.
      mgr.resubscribe()
      joinRoom(mgr, transport, COMP_ID, 'room:a', {})
      joinRoom(mgr, transport, COMP_ID, 'room:b', {})

      transport.emitBinary(buildFrame(BINARY_ROOM_EVENT, COMP_ID, 'room:a', 'evt', {}))
      transport.emitBinary(buildFrame(BINARY_ROOM_EVENT, COMP_ID, 'room:b', 'evt', {}))

      expect(handlerA).not.toHaveBeenCalled()
      expect(handlerB).not.toHaveBeenCalled()
    })
  })

  // --------------------------------------------------------------
  //  JSON path parity (handleServerMessage uses the same dispatch)
  // --------------------------------------------------------------
  describe('JSON path shares the same dispatch (dispatchToHandlers)', () => {
    it('JSON ROOM_EVENT fires handlers registered via handle.on()', () => {
      const mgr = transport.makeManager(COMP_ID)
      const handle = joinRoom(mgr, transport, COMP_ID, ROOM_ID, {})
      const handler = vi.fn()
      handle.on('chat:message' as any, handler)

      transport.emitJson({
        type: 'ROOM_EVENT',
        componentId: COMP_ID,
        roomId: ROOM_ID,
        event: 'chat:message',
        data: { text: 'hi' },
        timestamp: Date.now(),
      })

      expect(handler).toHaveBeenCalledWith({ text: 'hi' })
    })

    it('JSON ROOM_STATE fires $state:change handlers via onSystem', () => {
      const mgr = transport.makeManager(COMP_ID)
      const handle = joinRoom(mgr, transport, COMP_ID, ROOM_ID, { n: 0 })
      const handler = vi.fn()
      handle.onSystem('state:change', handler)

      transport.emitJson({
        type: 'ROOM_STATE',
        componentId: COMP_ID,
        roomId: ROOM_ID,
        event: '$state:update',
        data: { state: { n: 5 } },
        timestamp: Date.now(),
      })

      expect(handler).toHaveBeenCalledWith({ n: 5 })
    })
  })

  // --------------------------------------------------------------
  // Incoming frames must NOT depend on this.rooms having an entry.
  // Regression for the scenario reported on the issue-27 follow-up:
  //   client ~0.8.x/0.9.x-dev silently dropped ROOM_EVENT frames when
  //   `this.rooms.get(roomId)` returned undefined. `this.roomHandlers`
  //   is the only storage that must be consulted for dispatch.
  // --------------------------------------------------------------
  describe('Dispatch independent of this.rooms entry', () => {
    it('binary ROOM_EVENT fires handler even if this.rooms has no entry for the room', () => {
      const mgr = transport.makeManager(COMP_ID)
      const handle = mgr.createHandle(ROOM_ID)
      const handler = vi.fn()
      handle.on('chat:message', handler)

      // Simulate: React remount path — destroy() clears this.rooms and
      // this.handles but PRESERVES this.roomHandlers. Then a binary
      // ROOM_EVENT arrives before the consumer calls $room(id) again,
      // so this.rooms has no entry for ROOM_ID.
      mgr.destroy()
      mgr.resubscribe()

      transport.emitBinary(buildFrame(
        BINARY_ROOM_EVENT, COMP_ID, ROOM_ID, 'chat:message', { text: 'hi' },
      ))

      expect(handler).toHaveBeenCalledWith({ text: 'hi' })
    })

    it('JSON ROOM_EVENT fires handler even if this.rooms has no entry for the room', () => {
      const mgr = transport.makeManager(COMP_ID)
      const handle = mgr.createHandle(ROOM_ID)
      const handler = vi.fn()
      handle.on('chat:message', handler)

      mgr.destroy()
      mgr.resubscribe()

      transport.emitJson({
        type: 'ROOM_EVENT',
        componentId: COMP_ID,
        roomId: ROOM_ID,
        event: 'chat:message',
        data: { text: 'hi' },
        timestamp: Date.now(),
      })

      expect(handler).toHaveBeenCalledWith({ text: 'hi' })
    })

    it('binary ROOM_STATE merges state and fires $state:change even with no prior room entry', () => {
      const mgr = transport.makeManager(COMP_ID)
      const handle = mgr.createHandle(ROOM_ID)
      const sysHandler = vi.fn()
      handle.onSystem('state:change', sysHandler)

      mgr.destroy()
      mgr.resubscribe()

      transport.emitBinary(buildFrame(
        BINARY_ROOM_STATE, COMP_ID, ROOM_ID, '$state:update', { state: { n: 7 } },
      ))

      expect(sysHandler).toHaveBeenCalledWith({ n: 7 })
    })
  })
})
