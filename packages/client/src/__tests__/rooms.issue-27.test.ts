// Regression tests for issue #27:
// "room.on() e room.onSystem() não disparam no @fluxstack/live-client
//  (state é atualizado corretamente)"
//
// Hypothesis (per the issue report):
//   createHandle(roomId) captures `room = this.getOrCreateRoom(roomId)` in a closure
//   and caches the handle in `this.handles`. handleBinaryFrame reads
//   `this.rooms.get(parsed.roomId)` at delivery time. If `this.rooms` is mutated
//   (e.g. destroy() -> this.rooms.clear()) between handle creation and frame
//   arrival, the handle's closure points at an orphaned room object (which still
//   holds the registered handlers) while handleBinaryFrame looks up a brand-new
//   room object (with empty handlers). State is still merged into the new room's
//   state (user observes it), but the handlers never fire.
//
// These tests:
//   1. Reproduce the bug scenario step-by-step.
//   2. Exercise the React-like pattern: render -> destroy -> remount -> resubscribe.
//   3. Verify both binary (0x02 ROOM_EVENT, 0x03 ROOM_STATE) and JSON paths.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RoomManager } from '../rooms'
import type { RoomServerMessage } from '../rooms'

// ===== Binary frame builder (matches server wire format) =====

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

// ===== Test transport wiring (simulates one WebSocket + subscribe factories) =====

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

// Helper: simulate a ROOM_JOINED so the room exists
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

describe('Issue #27: room.on()/onSystem() silent handler loss after destroy+resubscribe', () => {
  let transport: Transport
  const COMP_ID = '8QdWP4ny'
  const ROOM_ID = 'game-chat:main'

  beforeEach(() => {
    transport = createTransport()
  })

  // ---------- Sanity: baseline behavior works ----------
  describe('baseline (no destroy/remount)', () => {
    it('binary ROOM_EVENT fires on() handler', () => {
      const mgr = transport.makeManager(COMP_ID)
      const handle = joinRoom(mgr, transport, COMP_ID, ROOM_ID, { messages: [] })
      const handler = vi.fn()
      handle.on('chat:message' as any, handler)

      transport.emitBinary(buildFrame(BINARY_ROOM_EVENT, COMP_ID, ROOM_ID, 'chat:message', {
        playerId: 'p1', playerName: 'Alice', text: 'hi', timestamp: 1,
      }))

      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('binary ROOM_STATE triggers $state:change handler', () => {
      const mgr = transport.makeManager(COMP_ID)
      const handle = joinRoom(mgr, transport, COMP_ID, ROOM_ID, { messages: [] })
      const stateHandler = vi.fn()
      handle.onSystem('state:change', stateHandler)

      transport.emitBinary(buildFrame(BINARY_ROOM_STATE, COMP_ID, ROOM_ID, '$state:update', {
        state: { messages: [{ text: 'hello' }] },
      }))

      expect(stateHandler).toHaveBeenCalledTimes(1)
    })
  })

  // ---------- The EXACT issue #27 scenario — now fixed ----------
  describe('fix: destroy() then resubscribe() + new handle', () => {
    it('on() handler registered on a handle captured before destroy re-fires after re-join', () => {
      const mgr = transport.makeManager(COMP_ID)
      const handle = joinRoom(mgr, transport, COMP_ID, ROOM_ID, { messages: [] })

      // A React component effect captures this handle reference.
      const handler = vi.fn()
      handle.on('chat:message' as any, handler)

      // React unmount -> destroy() clears this.rooms and this.handles.
      mgr.destroy()

      // React remount -> resubscribe wires up the transport factories again,
      // and the effect re-joins the room (same roomId).
      mgr.resubscribe()
      joinRoom(mgr, transport, COMP_ID, ROOM_ID, { messages: [] })
      // Re-register the handler via the same (now reusable) handle — this
      // mirrors what a React effect does on remount.
      handle.on('chat:message' as any, handler)

      // Server broadcasts a binary event targeting ROOM_ID.
      transport.emitBinary(buildFrame(BINARY_ROOM_EVENT, COMP_ID, ROOM_ID, 'chat:message', {
        playerId: 'p1', playerName: 'Alice', text: 'hi', timestamp: 1,
      }))

      // With the fix: handle.on() writes to the CURRENT room object in
      // this.rooms, and handleBinaryFrame reads from the same Map — so the
      // handler fires.
      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('after destroy()+re-join, state flows back to the same handle reference', () => {
      const mgr = transport.makeManager(COMP_ID)
      const handle = joinRoom(mgr, transport, COMP_ID, ROOM_ID, { messages: [] })

      mgr.destroy()
      mgr.resubscribe()
      joinRoom(mgr, transport, COMP_ID, ROOM_ID, { messages: [] })

      transport.emitBinary(buildFrame(BINARY_ROOM_STATE, COMP_ID, ROOM_ID, '$state:update', {
        state: { messages: [{ text: 'after-destroy' }] },
      }))

      // With the fix: handle.state dereferences the current room object via
      // getRoom() instead of a stale closure.
      expect(handle.state).toEqual({ messages: [{ text: 'after-destroy' }] })
    })
  })

  // ---------- Stale and fresh handles now converge ----------
  describe('fix: stale vs fresh handles converge on the same room', () => {
    it('after destroy+resubscribe+re-join, a handle kept from the first mount still receives events and state', () => {
      const mgr = transport.makeManager(COMP_ID)

      // --- First "mount" cycle ---
      const handleFromFirstMount = joinRoom(mgr, transport, COMP_ID, ROOM_ID, { messages: [] })
      const firstHandler = vi.fn()
      handleFromFirstMount.on('chat:message' as any, firstHandler)

      // --- React unmount ---
      mgr.destroy()

      // --- React remount ---
      mgr.resubscribe()
      // New handle from the remount — same roomId, so createHandle() returns
      // a new proxy (handles cache was cleared).
      const handleFromRemount = joinRoom(mgr, transport, COMP_ID, ROOM_ID, { messages: [] })
      const secondHandler = vi.fn()
      handleFromRemount.on('chat:message' as any, secondHandler)

      // Crucial: register a handler via the OLD handle AFTER the destroy cycle.
      // With the fix, handle.on() always writes to the current room object in
      // this.rooms — so this handler lives alongside the remount's handler.
      const restoredHandler = vi.fn()
      handleFromFirstMount.on('chat:message' as any, restoredHandler)

      // --- Server broadcasts ---
      transport.emitBinary(buildFrame(BINARY_ROOM_EVENT, COMP_ID, ROOM_ID, 'chat:message', {
        playerId: 'p1', playerName: 'Alice', text: 'after-remount', timestamp: 2,
      }))
      transport.emitBinary(buildFrame(BINARY_ROOM_STATE, COMP_ID, ROOM_ID, '$state:update', {
        state: { messages: [{ text: 'after-remount' }] },
      }))

      // Since v0.9.0 (issue #28): destroy() preserves this.roomHandlers, so
      // firstHandler — registered before destroy — also fires on re-join.
      // Consumers that want to wipe handlers must call removeAllListeners()
      // or disposeRoom(roomId) explicitly.
      expect(firstHandler).toHaveBeenCalledTimes(1)

      // Handlers registered AFTER the destroy cycle also fire.
      expect(secondHandler).toHaveBeenCalledTimes(1)
      expect(restoredHandler).toHaveBeenCalledTimes(1)

      // Both handles read state from the same (current) room object.
      expect(handleFromFirstMount.state).toEqual({ messages: [{ text: 'after-remount' }] })
      expect(handleFromRemount.state).toEqual({ messages: [{ text: 'after-remount' }] })
      expect(handleFromFirstMount.state).toEqual(handleFromRemount.state)
    })
  })

  // ---------- Repro with ONLY remount (no React-style handle reuse) ----------
  describe('bug repro: two RoomManager instances (simulates full React reset)', () => {
    it('handlers registered on a disposed manager do NOT fire on a new manager', () => {
      const disposed = transport.makeManager(COMP_ID)
      const disposedHandle = joinRoom(disposed, transport, COMP_ID, ROOM_ID, { messages: [] })
      const disposedHandler = vi.fn()
      disposedHandle.on('chat:message' as any, disposedHandler)
      disposed.destroy()

      // Fresh manager — simulates a full component remount with a new RoomManager.
      const fresh = transport.makeManager(COMP_ID)
      const freshHandle = joinRoom(fresh, transport, COMP_ID, ROOM_ID, { messages: [] })
      const freshHandler = vi.fn()
      freshHandle.on('chat:message' as any, freshHandler)

      transport.emitBinary(buildFrame(BINARY_ROOM_EVENT, COMP_ID, ROOM_ID, 'chat:message', {
        text: 'after-reset',
      }))

      expect(disposedHandler).not.toHaveBeenCalled()
      expect(freshHandler).toHaveBeenCalledTimes(1)
    })
  })

  // ---------- JSON path fix ----------
  describe('fix: JSON path (ROOM_EVENT / ROOM_STATE messages)', () => {
    it('JSON ROOM_EVENT reaches a handle kept across destroy + re-register', () => {
      const mgr = transport.makeManager(COMP_ID)
      const handle = joinRoom(mgr, transport, COMP_ID, ROOM_ID, { messages: [] })
      const handler = vi.fn()
      handle.on('chat:message' as any, handler)

      mgr.destroy()
      mgr.resubscribe()
      joinRoom(mgr, transport, COMP_ID, ROOM_ID, { messages: [] })
      handle.on('chat:message' as any, handler)

      transport.emitJson({
        type: 'ROOM_EVENT',
        componentId: COMP_ID,
        roomId: ROOM_ID,
        event: 'chat:message',
        data: { text: 'hi' },
        timestamp: Date.now(),
      })

      expect(handler).toHaveBeenCalledTimes(1)
    })
  })

  // ---------- "State updates, events don't" — user report, now fixed ----------
  describe('fix: exact user report (state visible AND handlers fire)', () => {
    it('onSystem(state:change) on an old handle fires when re-registered after remount', () => {
      const mgr = transport.makeManager(COMP_ID)

      // Handle + handler (registered "before" unmount)
      const handleFromFirstMount = joinRoom(mgr, transport, COMP_ID, ROOM_ID, { messages: [] })
      const firstStateHandler = vi.fn()
      handleFromFirstMount.onSystem('state:change', firstStateHandler)

      // Simulate unmount/remount cycle (React effect cleanup + re-run)
      mgr.destroy()
      mgr.resubscribe()

      // Remount effect re-joins the room and re-registers the handler using
      // the handle it closed over.
      const handleFromRemount = joinRoom(mgr, transport, COMP_ID, ROOM_ID, { messages: [] })
      const secondStateHandler = vi.fn()
      handleFromFirstMount.onSystem('state:change', secondStateHandler)

      // Server pushes state delta
      transport.emitBinary(buildFrame(BINARY_ROOM_STATE, COMP_ID, ROOM_ID, '$state:update', {
        state: { messages: [{ playerId: 'p1', text: 'visible-in-state' }] },
      }))

      // state is visible on both handles (they resolve the same room lazily).
      expect(handleFromFirstMount.state).toEqual({
        messages: [{ playerId: 'p1', text: 'visible-in-state' }],
      })
      expect(handleFromRemount.state).toEqual(handleFromFirstMount.state)

      // Since v0.9.0 (issue #28): destroy() no longer wipes handlers.
      // Both firstStateHandler (registered before destroy) and
      // secondStateHandler (registered after) fire on the state delta.
      expect(firstStateHandler).toHaveBeenCalledTimes(1)
      expect(secondStateHandler).toHaveBeenCalledTimes(1)
      expect(secondStateHandler).toHaveBeenCalledWith({
        messages: [{ playerId: 'p1', text: 'visible-in-state' }],
      })
    })
  })
})
