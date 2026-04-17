// Simulates the exact lifecycle sequence that React 19 + Strict Mode triggers
// around RoomManager, to catch the bug reported in the newBaby app where
// `room.on('chat:message', handler)` stops firing after remount — even though
// binary ROOM_EVENT frames keep arriving on the wire.
//
// The React flow (see packages/react/src/hooks/useLiveComponent.ts):
//   - useMemo creates RoomManager, passing onBinaryMessage that calls
//     registerRoomBinaryHandler on the transport
//   - useEffect [roomManager] calls resubscribe() on setup, destroy() on cleanup
//   - Strict Mode invokes setup → cleanup → setup again on initial mount
//   - If componentId changes later (rehydrate → mount), useMemo reuses the
//     instance via roomManagerRef and only calls setComponentId()
//
// This suite exercises each of those transitions and asserts that a handler
// registered via `room.on(event, handler)` still fires when a binary
// ROOM_EVENT arrives.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RoomManager } from '../rooms'
import type { RoomServerMessage } from '../rooms'

// ===== Binary frame helpers =====

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
    if (Number.isInteger(value) && value >= 0 && value < 128) { parts.push(new Uint8Array([value])); return }
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

function buildFrame(frameType: number, componentId: string, roomId: string, event: string, data: unknown): Uint8Array {
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

// ===== Transport simulator (mirrors LiveConnection semantics) =====

interface SimulatedTransport {
  jsonHandlers: Set<(msg: RoomServerMessage) => void>
  binaryHandlers: Set<(frame: Uint8Array) => void>
  emitBinary(frame: Uint8Array): void
  emitJson(msg: RoomServerMessage): void
  makeRoomManager(componentId: string | null): RoomManager
}

function createTransport(): SimulatedTransport {
  const jsonHandlers = new Set<(msg: RoomServerMessage) => void>()
  const binaryHandlers = new Set<(frame: Uint8Array) => void>()
  return {
    jsonHandlers,
    binaryHandlers,
    emitBinary(frame) {
      // Mirror LiveConnection.handleBinaryMessage: fan out to ALL registered
      // binary handlers (for..of without try/catch, matching current code).
      for (const h of binaryHandlers) h(frame)
    },
    emitJson(msg) { for (const h of jsonHandlers) h(msg) },
    makeRoomManager(componentId) {
      return new RoomManager({
        componentId,
        sendMessage: vi.fn(),
        sendMessageAndWait: vi.fn().mockResolvedValue({ success: true, state: {} }),
        onMessage: (h) => { jsonHandlers.add(h); return () => { jsonHandlers.delete(h) } },
        onBinaryMessage: (h) => { binaryHandlers.add(h); return () => { binaryHandlers.delete(h) } },
      })
    },
  }
}

// ===============================================================

describe('React Strict Mode + remount lifecycle — room handlers must survive', () => {
  const COMP_ID = 'c-1'
  const ROOM_ID = 'game-chat:main'
  let transport: SimulatedTransport

  beforeEach(() => { transport = createTransport() })

  it('Strict Mode double-invocation: setup → cleanup → setup, handler registered once still fires', () => {
    // useMemo creates RoomManager; useEffect [roomManager] runs setup.
    const mgr = transport.makeRoomManager(COMP_ID)

    // Consumer code (mount): ChatPanel does `room.on('chat:message', handler)`.
    const handle = mgr.createHandle(ROOM_ID)
    const handler = vi.fn()
    handle.on('chat:message', handler)

    // Strict Mode cleanup fires immediately after first setup.
    mgr.destroy()
    // Strict Mode setup re-runs on the same instance.
    mgr.resubscribe()

    // Server emits the event (binary 0x02 ROOM_EVENT).
    transport.emitBinary(buildFrame(BINARY_ROOM_EVENT, COMP_ID, ROOM_ID, 'chat:message', { text: 'hi' }))

    expect(handler).toHaveBeenCalledWith({ text: 'hi' })
  })

  it('componentId changes after rehydrate: useMemo reuses instance via setComponentId; frame arrives with NEW id and still dispatches', () => {
    // Initial mount with OLD componentId (say, from rehydrate attempt).
    const mgr = transport.makeRoomManager('old-id')
    const handle = mgr.createHandle(ROOM_ID)
    const handler = vi.fn()
    handle.on('chat:message', handler)

    // Rehydrate fails → server assigns NEW componentId via COMPONENT_MOUNT.
    // useEffect [componentId] calls setComponentId(newId).
    mgr.setComponentId(COMP_ID)

    // Server sends binary event with the new componentId.
    transport.emitBinary(buildFrame(BINARY_ROOM_EVENT, COMP_ID, ROOM_ID, 'chat:message', { text: 'yo' }))

    expect(handler).toHaveBeenCalledWith({ text: 'yo' })
  })

  it('destroy → resubscribe → rejoin → emit: handler registered BEFORE destroy still fires after', () => {
    const mgr = transport.makeRoomManager(COMP_ID)
    const handle = mgr.createHandle(ROOM_ID)
    const handler = vi.fn()
    handle.on('chat:message', handler)

    // Simulate effect cleanup (component unmount OR dep change)
    mgr.destroy()

    // Simulate effect setup on remount (same instance via roomManagerRef)
    mgr.resubscribe()

    // Consumer does NOT re-call createHandle nor re-register the handler —
    // it never had a reason to, because its own useEffect deps didn't change.
    // The handler was preserved in this.roomHandlers.

    transport.emitBinary(buildFrame(BINARY_ROOM_EVENT, COMP_ID, ROOM_ID, 'chat:message', { text: 'persist' }))
    expect(handler).toHaveBeenCalledWith({ text: 'persist' })
  })

  it('handler registered AFTER destroy (between cleanup and resubscribe) via fresh createHandle still fires', () => {
    // This is the ChatPanel flow: useEffect with deps [tank?.$status, playerId]
    // fires cleanup then setup. The setup calls tank.$room(...).on(...).
    const mgr = transport.makeRoomManager(COMP_ID)
    const h1 = mgr.createHandle(ROOM_ID)
    const handlerA = vi.fn()
    h1.on('chat:message', handlerA)

    // Effect cleanup — offMessage() unsubscribes handlerA
    // (simulating the `return () => { offMessage?.() }` in ChatPanel useEffect)
    // But the useEffect cleanup in useLiveComponent [roomManager] also runs
    // and calls destroy().
    mgr.destroy()
    mgr.resubscribe()

    // ChatPanel's useEffect setup re-runs, gets a fresh handle, registers new handler
    const h2 = mgr.createHandle(ROOM_ID)
    const handlerB = vi.fn()
    h2.on('chat:message', handlerB)

    // Server emits
    transport.emitBinary(buildFrame(BINARY_ROOM_EVENT, COMP_ID, ROOM_ID, 'chat:message', { text: 'new' }))

    // handlerB should fire; handlerA was explicitly removed by the caller.
    // In our simulation we didn't call the offMessage(), but handlerA is
    // still in roomHandlers. This mirrors the real behavior if consumer
    // didn't unsub. Both should be callable — but the test shape matches
    // the real ChatPanel which DOES call offMessage in cleanup.
    expect(handlerB).toHaveBeenCalledWith({ text: 'new' })
  })

  it('MULTIPLE RoomManagers registered on same transport: each filters by componentId, no cross-talk, no blocking', () => {
    // This is what happens if there are TWO LiveComponents on the page, each
    // with its own RoomManager registered on the same LiveConnection.
    const mgrA = transport.makeRoomManager('comp-A')
    const mgrB = transport.makeRoomManager('comp-B')

    const handleA = mgrA.createHandle(ROOM_ID)
    const handleB = mgrB.createHandle(ROOM_ID)

    const hA = vi.fn()
    const hB = vi.fn()
    handleA.on('chat:message', hA)
    handleB.on('chat:message', hB)

    // Frame for comp-B arrives. mgrA filters it out (componentId mismatch),
    // mgrB dispatches. Critically, mgrA's filter MUST NOT throw — if it did,
    // the for..of loop in LiveConnection would skip mgrB.
    transport.emitBinary(buildFrame(BINARY_ROOM_EVENT, 'comp-B', ROOM_ID, 'chat:message', { text: 'for-B' }))

    expect(hA).not.toHaveBeenCalled()
    expect(hB).toHaveBeenCalledWith({ text: 'for-B' })
  })

  it('REGRESSION for newBaby scenario: effect deps change (tank.$status transitions pending→synced) causes cleanup+re-register; frames chegando após o re-register disparam handler', () => {
    // Exact sequence from the dev's logs:
    //   [ChatPanel DIAG] tank.$status= synced (first register, state vazio)
    //   [LiveConnection] Sent CALL_ACTION (joinMatch)
    //   [LiveConnection] Received ROOM_JOINED
    //   [ChatPanel DIAG] cleanup (re-render because $status changed again? or effect deps)
    //   [ChatPanel DIAG] tank.$status= synced (second register, state populado)
    //   [LiveConnection] Sent CALL_ACTION (sendChat)
    //   BIN ROOM_STATE len=141  ← state atualiza OK
    //   BIN ROOM_EVENT len=122  ← handler DEVE disparar

    const mgr = transport.makeRoomManager(COMP_ID)

    // First effect run
    const h1 = mgr.createHandle(ROOM_ID)
    const handlerA = vi.fn()
    const unsubA = h1.on('chat:message', handlerA)

    // Simulate ROOM_JOINED
    transport.emitJson({
      type: 'ROOM_JOINED', componentId: COMP_ID, roomId: ROOM_ID,
      event: '$room:joined', data: { state: { messages: [] } }, timestamp: Date.now(),
    })

    // Dep changes → effect cleanup → offMessage()
    unsubA()
    // Also: useEffect [roomManager] DID NOT re-run because roomManager identity
    // stable (useMemo returned same instance via ref). So destroy() is NOT called.
    // The ChatPanel effect does re-run, though, because its own deps changed.

    // Second effect run — ChatPanel re-registers
    const h2 = mgr.createHandle(ROOM_ID)
    const handlerB = vi.fn()
    h2.on('chat:message', handlerB)

    // sendChat action → server emits binary ROOM_EVENT
    transport.emitBinary(buildFrame(BINARY_ROOM_EVENT, COMP_ID, ROOM_ID, 'chat:message', { text: 'hello world' }))

    expect(handlerA).not.toHaveBeenCalled()      // was unsubscribed
    expect(handlerB).toHaveBeenCalledWith({ text: 'hello world' })
  })

  it('REGRESSION for the FULL cleanup of useEffect [roomManager]: destroy clears this.rooms + this.handles but handlers in roomHandlers survive; frame arriving right after destroy, before any re-createHandle, still fires', () => {
    // This is the WINDOW the dev might be hitting: destroy runs, frame arrives
    // BEFORE the ChatPanel re-renders and calls tank.$room(...).on(...).
    const mgr = transport.makeRoomManager(COMP_ID)
    const h1 = mgr.createHandle(ROOM_ID)
    const handler = vi.fn()
    h1.on('chat:message', handler)

    mgr.destroy()
    // Frame arrives RIGHT NOW — no resubscribe yet, no new createHandle yet.
    // In the REAL code, destroy() unsubscribed binaryUnsubscribe, so frames
    // wouldn't even reach this RoomManager. But after resubscribe() they would.
    mgr.resubscribe()

    transport.emitBinary(buildFrame(BINARY_ROOM_EVENT, COMP_ID, ROOM_ID, 'chat:message', { text: 'race' }))

    // Handler stored in this.roomHandlers.get(ROOM_ID) — independent of this.rooms.
    expect(handler).toHaveBeenCalledWith({ text: 'race' })
  })
})
