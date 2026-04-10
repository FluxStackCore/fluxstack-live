// Regression tests for issue #7: protocol, codec, framing, batching.
//
// Promoted from __tests__/bug-hunt/protocol-codec.test.ts after the fixes.
// Each hypothesis is now asserted in its post-fix form.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ComponentStateManager } from '../../component/managers/ComponentStateManager'
import {
  queueWsMessage,
  sendBinaryImmediate,
  getBatcherStats,
  resetBatcherStats,
} from '../../transport/WsSendBatcher'
import {
  msgpackCodec,
  buildRoomFrame,
  buildRoomFrameTail,
  parseRoomFrame,
  prependMemberHeader,
  BINARY_ROOM_EVENT,
} from '../../rooms/RoomCodec'
import { ComponentMessaging } from '../../component/managers/ComponentMessaging'

// Keep the logger quiet so expected warnings do not pollute the test output.
vi.mock('../../debug/LiveLogger', async () => {
  const actual = await vi.importActual<any>('../../debug/LiveLogger')
  return {
    ...actual,
    liveLog: vi.fn(),
    liveWarn: vi.fn(),
  }
})

function mockWs() {
  return {
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1,
    data: {} as any,
    remoteAddress: '127.0.0.1',
  } as any
}

function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length
}

beforeEach(() => {
  resetBatcherStats()
  vi.clearAllMocks()
})

// ===========================================================================
// fixes #7 H1 — componentId > 255 bytes in sendBinaryDelta throws loudly
// ===========================================================================
describe('fixes #7 H1: oversized componentId in sendBinaryDelta', () => {
  it('throws instead of silently truncating the u8 length prefix', () => {
    const ws = mockWs()
    const longId = 'live-' + 'A'.repeat(300)
    expect(utf8Len(longId)).toBeGreaterThan(255)

    const sm = new ComponentStateManager<{ x: number }>({
      componentId: longId,
      initialState: { x: 0 },
      ws,
      emitFn: () => {},
      onStateChangeFn: () => {},
    })

    expect(() =>
      sm.sendBinaryDelta({ x: 1 }, (d) => new TextEncoder().encode(JSON.stringify(d)))
    ).toThrow(/exceeds the 255-byte limit/)
    expect(ws.send).not.toHaveBeenCalled()
  })

  it('normal-sized componentId still works', () => {
    const ws = mockWs()
    const sm = new ComponentStateManager<{ x: number }>({
      componentId: 'live-12345',
      initialState: { x: 0 },
      ws,
      emitFn: () => {},
      onStateChangeFn: () => {},
    })

    sm.sendBinaryDelta({ x: 1 }, (d) => new TextEncoder().encode(JSON.stringify(d)))
    expect(ws.send).toHaveBeenCalledOnce()
    const frame = ws.send.mock.calls[0][0] as Uint8Array
    expect(frame[1]).toBe(utf8Len('live-12345'))
  })
})

// ===========================================================================
// fixes #7 H2 — oversized componentId / roomId / event in RoomCodec
// ===========================================================================
describe('fixes #7 H2: oversized frame fields in RoomCodec', () => {
  it('buildRoomFrame rejects componentId > 255 bytes', () => {
    const longComp = 'c'.repeat(260)
    expect(() =>
      buildRoomFrame(BINARY_ROOM_EVENT, longComp, 'room', 'evt', new Uint8Array())
    ).toThrow(/componentId.*exceeds the 255-byte limit/)
  })

  it('buildRoomFrame rejects roomId > 255 bytes', () => {
    const longRoom = 'r'.repeat(300)
    expect(() =>
      buildRoomFrame(BINARY_ROOM_EVENT, 'c', longRoom, 'evt', new Uint8Array())
    ).toThrow(/roomId.*exceeds the 255-byte limit/)
  })

  it('buildRoomFrame rejects event > 65535 bytes', () => {
    const longEvent = 'e'.repeat(70000)
    expect(() =>
      buildRoomFrame(BINARY_ROOM_EVENT, 'c', 'r', longEvent, new Uint8Array())
    ).toThrow(/event.*exceeds the 65535-byte limit/)
  })

  it('buildRoomFrameTail rejects roomId > 255 bytes', () => {
    const longRoom = 'r'.repeat(300)
    expect(() =>
      buildRoomFrameTail(longRoom, 'evt', new Uint8Array())
    ).toThrow(/roomId.*exceeds the 255-byte limit/)
  })

  it('prependMemberHeader rejects componentId > 255 bytes', () => {
    const longComp = 'c'.repeat(260)
    expect(() =>
      prependMemberHeader(BINARY_ROOM_EVENT, longComp, new Uint8Array([1, 2, 3]))
    ).toThrow(/componentId.*exceeds the 255-byte limit/)
  })

  it('normal-sized fields roundtrip through buildRoomFrame / parseRoomFrame', () => {
    const frame = buildRoomFrame(BINARY_ROOM_EVENT, 'comp-1', 'lobby', 'msg', new Uint8Array([9, 8, 7]))
    const parsed = parseRoomFrame(frame)
    expect(parsed).not.toBeNull()
    expect(parsed!.componentId).toBe('comp-1')
    expect(parsed!.roomId).toBe('lobby')
    expect(parsed!.event).toBe('msg')
    expect(Array.from(parsed!.payload)).toEqual([9, 8, 7])
  })
})

// ===========================================================================
// fixes #7 H3 — circular reference in msgpack encoder
// ===========================================================================
describe('fixes #7 H3: msgpack encoder detects circular references', () => {
  it('throws a TypeError with a clear message on a circular object', () => {
    const obj: any = { a: 1 }
    obj.self = obj

    expect(() => msgpackCodec.encode(obj)).toThrow(/Circular reference/)
  })

  it('throws on a circular array too', () => {
    const arr: any[] = [1, 2]
    arr.push(arr)

    expect(() => msgpackCodec.encode(arr)).toThrow(/Circular reference/)
  })

  it('disjoint references to the same sub-object are NOT flagged as circular', () => {
    // A shared plain sub-object that appears under two different keys is
    // not a cycle — it is a DAG. The seen-set is removed on the way up.
    const shared = { x: 1 }
    const obj = { a: shared, b: shared }
    expect(() => msgpackCodec.encode(obj)).not.toThrow()
    const decoded = msgpackCodec.decode(msgpackCodec.encode(obj)) as any
    expect(decoded.a).toEqual({ x: 1 })
    expect(decoded.b).toEqual({ x: 1 })
  })
})

// ===========================================================================
// fixes #7 H4 — WsSendBatcher reports serialization failures
// ===========================================================================
describe('fixes #7 H4: WsSendBatcher surfaces serialization errors', () => {
  it('circular payload increments droppedSerializationError', async () => {
    const ws = mockWs()
    const circular: any = { foo: 'bar' }
    circular.self = circular

    queueWsMessage(ws, {
      type: 'STATE_DELTA',
      componentId: 'c1',
      payload: circular,
      timestamp: Date.now(),
    })

    await new Promise((r) => queueMicrotask(() => r(undefined)))

    expect(ws.send).not.toHaveBeenCalled()
    expect(getBatcherStats().droppedSerializationError).toBeGreaterThan(0)
  })
})

// ===========================================================================
// fixes #7 H5/H6 — WS closed drops are counted
// ===========================================================================
describe('fixes #7 H5/H6: closed-ws drops are counted', () => {
  it('queueWsMessage on a closed ws increments droppedClosed and does not send', () => {
    const ws = mockWs()
    ws.readyState = 3 // CLOSED
    queueWsMessage(ws, {
      type: 'STATE_DELTA',
      componentId: 'c1',
      payload: { delta: { x: 1 } },
      timestamp: Date.now(),
    })
    expect(ws.send).not.toHaveBeenCalled()
    expect(getBatcherStats().droppedClosed).toBeGreaterThan(0)
  })

  it('ws closed between queue and flush counts all pending messages as closed', async () => {
    const ws = mockWs()
    queueWsMessage(ws, {
      type: 'STATE_DELTA',
      componentId: 'c1',
      payload: { delta: { x: 1 } },
      timestamp: Date.now(),
    })
    queueWsMessage(ws, {
      type: 'STATE_DELTA',
      componentId: 'c1',
      payload: { delta: { y: 2 } },
      timestamp: Date.now(),
    })
    // Simulate ws closing before the microtask flush
    ws.readyState = 3
    await new Promise((r) => queueMicrotask(() => r(undefined)))
    expect(ws.send).not.toHaveBeenCalled()
    expect(getBatcherStats().droppedClosed).toBeGreaterThanOrEqual(2)
  })

  it('sendBinaryImmediate on closed ws counts the drop', () => {
    const ws = mockWs()
    ws.readyState = 3
    sendBinaryImmediate(ws, new Uint8Array([1, 2, 3]))
    expect(ws.send).not.toHaveBeenCalled()
    expect(getBatcherStats().droppedClosed).toBeGreaterThan(0)
  })
})

// ===========================================================================
// fixes #7 H7 — backpressure drops are counted and warned (once)
// ===========================================================================
describe('fixes #7 H7: backpressure telemetry', () => {
  it('queue overflow increments droppedBackpressure', async () => {
    const ws = mockWs()
    // Push more than MAX_QUEUE_SIZE (1000) messages — 100 should be dropped.
    for (let i = 0; i < 1100; i++) {
      queueWsMessage(ws, {
        type: 'CUSTOM',
        componentId: `c${i}`,
        payload: { i },
        timestamp: Date.now(),
      })
    }
    await new Promise((r) => queueMicrotask(() => r(undefined)))

    expect(getBatcherStats().droppedBackpressure).toBeGreaterThanOrEqual(100)
  })
})

// ===========================================================================
// fixes #7 H8 — binary vs batched ordering is preserved
// ===========================================================================
describe('fixes #7 H8: sendBinaryImmediate flushes the queue first', () => {
  it('JSON enqueued before a binary immediate lands on the wire first', async () => {
    const ws = mockWs()

    queueWsMessage(ws, {
      type: 'STATE_DELTA',
      componentId: 'c1',
      payload: { delta: { x: 1 } },
      timestamp: Date.now(),
    })

    sendBinaryImmediate(ws, new Uint8Array([0x01, 0x02]))

    // Both should have happened synchronously in order: JSON then binary.
    expect(ws.send.mock.calls.length).toBe(2)
    const first = ws.send.mock.calls[0][0]
    const second = ws.send.mock.calls[1][0]
    expect(typeof first).toBe('string') // JSON
    expect(second).toBeInstanceOf(Uint8Array) // Binary
  })
})

// ===========================================================================
// fixes #7 H11 — msgpack decode rejects truncated input
// ===========================================================================
describe('fixes #7 H11: msgpack decode rejects truncated input', () => {
  it('throws RangeError on a truncated encoded buffer', () => {
    const full = msgpackCodec.encode({ key: 'longvalue-longvalue-longvalue', num: 12345 }) as Uint8Array
    const truncated = full.slice(0, full.length - 5)

    expect(() => msgpackCodec.decode(truncated)).toThrow(RangeError)
  })

  it('throws on a buffer that cuts in the middle of a string length field', () => {
    // A str16 header is 3 bytes: [0xda, lenHi, lenLo]. Truncate after 0xda.
    const partial = new Uint8Array([0xda])
    expect(() => msgpackCodec.decode(partial)).toThrow(RangeError)
  })

  it('does not crash on an empty buffer — throws cleanly', () => {
    expect(() => msgpackCodec.decode(new Uint8Array(0))).toThrow(RangeError)
  })
})

// ===========================================================================
// fixes #7 H12 — msgpack encoder rejects unsupported types
// ===========================================================================
describe('fixes #7 H12: msgpack encoder rejects unsupported types', () => {
  it('throws on BigInt', () => {
    expect(() => msgpackCodec.encode({ big: 123n })).toThrow(/BigInt/)
  })

  it('throws on Date', () => {
    expect(() => msgpackCodec.encode({ d: new Date(0) })).toThrow(/Date/)
  })

  it('throws on Map', () => {
    expect(() => msgpackCodec.encode({ m: new Map([['a', 1]]) })).toThrow(/Map/)
  })

  it('throws on Set', () => {
    expect(() => msgpackCodec.encode({ s: new Set([1]) })).toThrow(/Set/)
  })

  it('throws on RegExp', () => {
    expect(() => msgpackCodec.encode({ r: /abc/ })).toThrow(/RegExp/)
  })

  it('throws on Symbol', () => {
    expect(() => msgpackCodec.encode({ s: Symbol('x') })).toThrow(/Symbol/)
  })

  it('throws on Function', () => {
    expect(() => msgpackCodec.encode({ f: () => 1 })).toThrow(/Function/)
  })
})

// ===========================================================================
// H9 — documented limitation: emit() accepts any string as type
// ===========================================================================
describe('documented limitation H9: ComponentMessaging.emit does not validate the type string', () => {
  // There is no runtime whitelist of message types in emit(). The union
  // type `LiveMessage['type']` is TypeScript-only. Adding a runtime gate
  // is low-value (no security impact) and would couple the transport to
  // the protocol schema. Kept as a pinned test so any future change is
  // an explicit decision.
  it('emit accepts an arbitrary type string and the batcher sends it', async () => {
    const ws = mockWs()
    const messaging = new ComponentMessaging({
      componentId: 'c1',
      ws,
      getUserId: () => undefined,
      getRoom: () => undefined,
      getBroadcastToRoom: () => () => {},
      getEmitOverride: () => null,
    })

    messaging.emit('TOTALLY_FAKE_TYPE_XYZ' as any, { hello: 'world' })
    await new Promise((r) => queueMicrotask(() => r(undefined)))

    expect(ws.send).toHaveBeenCalled()
    const payload = JSON.parse(ws.send.mock.calls[0][0])
    const msg = Array.isArray(payload) ? payload[0] : payload
    expect(msg.type).toBe('TOTALLY_FAKE_TYPE_XYZ')
  })
})
