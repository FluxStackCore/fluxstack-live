// Bug hunt: WsSendBatcher — caller-state corruption via shared references,
// backpressure ordering, send() throw recovery, ws.readyState transitions
// across the queue→flush gap, and binary/text ordering.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  queueWsMessage,
  queuePreSerialized,
  sendImmediate,
  sendBinaryImmediate,
  getBatcherStats,
  resetBatcherStats,
} from '../../transport/WsSendBatcher'
import { MAX_QUEUE_SIZE } from '../../protocol/constants'

vi.mock('../../debug/LiveLogger', () => ({
  liveLog: vi.fn(),
  liveWarn: vi.fn(),
}))

interface MockWS {
  readyState: number
  send: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
}

function mockWS(): MockWS {
  return {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
  }
}

/** Wait for the microtask queue to flush. */
function nextMicrotask(): Promise<void> {
  return Promise.resolve().then(() => Promise.resolve())
}

beforeEach(() => { resetBatcherStats() })
afterEach(() => { resetBatcherStats() })

// ─────────────────────────────────────────────────────────────────────────
// STATE_DELTA deduplication (the deduplicateDeltas function)
// ─────────────────────────────────────────────────────────────────────────

describe('STATE_DELTA dedup — caller-state ownership', () => {
  it('🔍 caller delta object is NOT mutated by dedup (shallow clone)', async () => {
    const ws = mockWS()
    const originalDelta = { count: 1 }
    queueWsMessage(ws as any, { type: 'STATE_DELTA', componentId: 'c1', payload: { delta: originalDelta }, timestamp: 1 })
    queueWsMessage(ws as any, { type: 'STATE_DELTA', componentId: 'c1', payload: { delta: { count: 2 } }, timestamp: 2 })
    await nextMicrotask()
    // The original delta reference handed in by the caller must remain { count: 1 }.
    expect(originalDelta).toEqual({ count: 1 })
  })

  it('nested objects inside the first delta are NOT mutated by a later merge', async () => {
    // mergeDeltas recurses by building new objects rather than mutating in
    // place, so the caller's nested reference survives intact. This pins
    // that contract — a regression to in-place merge would be visible here.
    const ws = mockWS()
    const nested = { hp: 100 }
    const first = { player: nested }
    queueWsMessage(ws as any, { type: 'STATE_DELTA', componentId: 'c1', payload: { delta: first }, timestamp: 1 })
    queueWsMessage(ws as any, { type: 'STATE_DELTA', componentId: 'c1', payload: { delta: { player: { hp: 50 } } }, timestamp: 2 })
    await nextMicrotask()
    expect(nested.hp).toBe(100)
  })

  it('merges two deltas for the same componentId into one STATE_DELTA', async () => {
    const ws = mockWS()
    queueWsMessage(ws as any, { type: 'STATE_DELTA', componentId: 'c1', payload: { delta: { a: 1 } }, timestamp: 1 })
    queueWsMessage(ws as any, { type: 'STATE_DELTA', componentId: 'c1', payload: { delta: { b: 2 } }, timestamp: 2 })
    await nextMicrotask()
    const sent = JSON.parse(ws.send.mock.calls[0]![0] as string)
    // Single delta with merged payload
    expect(Array.isArray(sent)).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0].payload.delta).toEqual({ a: 1, b: 2 })
  })

  it('does NOT merge deltas for different componentIds', async () => {
    const ws = mockWS()
    queueWsMessage(ws as any, { type: 'STATE_DELTA', componentId: 'c1', payload: { delta: { a: 1 } }, timestamp: 1 })
    queueWsMessage(ws as any, { type: 'STATE_DELTA', componentId: 'c2', payload: { delta: { a: 2 } }, timestamp: 2 })
    await nextMicrotask()
    const sent = JSON.parse(ws.send.mock.calls[0]![0] as string)
    expect(sent).toHaveLength(2)
  })

  it('does NOT merge non-STATE_DELTA messages', async () => {
    const ws = mockWS()
    queueWsMessage(ws as any, { type: 'CUSTOM', componentId: 'c1', payload: { a: 1 }, timestamp: 1 })
    queueWsMessage(ws as any, { type: 'CUSTOM', componentId: 'c1', payload: { b: 2 }, timestamp: 2 })
    await nextMicrotask()
    const sent = JSON.parse(ws.send.mock.calls[0]![0] as string)
    expect(sent).toHaveLength(2)
  })

  it('later delta wins on conflicting key (last-write-wins for primitives)', async () => {
    const ws = mockWS()
    queueWsMessage(ws as any, { type: 'STATE_DELTA', componentId: 'c1', payload: { delta: { x: 1 } }, timestamp: 1 })
    queueWsMessage(ws as any, { type: 'STATE_DELTA', componentId: 'c1', payload: { delta: { x: 99 } }, timestamp: 2 })
    await nextMicrotask()
    const sent = JSON.parse(ws.send.mock.calls[0]![0] as string)
    expect(sent[0].payload.delta).toEqual({ x: 99 })
  })

  it('deep-merges nested plain objects (regression for #22)', async () => {
    const ws = mockWS()
    queueWsMessage(ws as any, { type: 'STATE_DELTA', componentId: 'c1', payload: { delta: { players: { p1: 'Alice' } } }, timestamp: 1 })
    queueWsMessage(ws as any, { type: 'STATE_DELTA', componentId: 'c1', payload: { delta: { players: { p2: 'Bob' } } }, timestamp: 2 })
    await nextMicrotask()
    const sent = JSON.parse(ws.send.mock.calls[0]![0] as string)
    expect(sent[0].payload.delta).toEqual({ players: { p1: 'Alice', p2: 'Bob' } })
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Backpressure
// ─────────────────────────────────────────────────────────────────────────

describe('backpressure', () => {
  it('drops oldest message and increments counter when queue is at MAX_QUEUE_SIZE', async () => {
    const ws = mockWS()
    for (let i = 0; i < MAX_QUEUE_SIZE + 5; i++) {
      queueWsMessage(ws as any, { type: 'X', componentId: `c-${i}`, payload: { i }, timestamp: i })
    }
    const stats = getBatcherStats()
    expect(stats.droppedBackpressure).toBe(5)
    await nextMicrotask()
    // Confirm only MAX_QUEUE_SIZE were sent.
    const sent = JSON.parse(ws.send.mock.calls[0]![0] as string)
    expect(sent.length).toBe(MAX_QUEUE_SIZE)
    // And the OLDEST (i=0..4) were dropped — newest survived.
    const firstI = sent[0].payload.i
    expect(firstI).toBe(5)
  })

  it('pre-serialized messages share the same backpressure budget', async () => {
    const ws = mockWS()
    for (let i = 0; i < MAX_QUEUE_SIZE + 3; i++) {
      queuePreSerialized(ws as any, `{"n":${i}}`)
    }
    expect(getBatcherStats().droppedBackpressure).toBe(3)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Closed ws between queue and flush
// ─────────────────────────────────────────────────────────────────────────

describe('readyState transitions', () => {
  it('drops messages queued when ws is already not OPEN', () => {
    const ws = mockWS()
    ws.readyState = 3 // CLOSED
    queueWsMessage(ws as any, { type: 'X', componentId: 'c', payload: {}, timestamp: 1 })
    expect(getBatcherStats().droppedClosed).toBe(1)
    expect(ws.send).not.toHaveBeenCalled()
  })

  it('drops queued messages when ws closes between queue and flush', async () => {
    const ws = mockWS()
    queueWsMessage(ws as any, { type: 'X', componentId: 'c', payload: { a: 1 }, timestamp: 1 })
    queueWsMessage(ws as any, { type: 'X', componentId: 'c', payload: { b: 2 }, timestamp: 2 })
    ws.readyState = 3 // closed before flush fires
    await nextMicrotask()
    expect(ws.send).not.toHaveBeenCalled()
    expect(getBatcherStats().droppedClosed).toBe(2)
  })

  it('null ws is silently no-op (no count change either)', () => {
    queueWsMessage(null as any, { type: 'X', componentId: 'c', payload: {}, timestamp: 1 })
    expect(getBatcherStats().droppedClosed).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// ws.send() throwing (network died, BigInt in payload, circular ref)
// ─────────────────────────────────────────────────────────────────────────

describe('send() throws during flush', () => {
  it('counts the entire batch as dropped and does not propagate the throw', async () => {
    const ws = mockWS()
    ws.send.mockImplementation(() => { throw new Error('write after close') })
    queueWsMessage(ws as any, { type: 'X', componentId: 'c', payload: { a: 1 }, timestamp: 1 })
    queueWsMessage(ws as any, { type: 'X', componentId: 'c', payload: { b: 2 }, timestamp: 2 })
    // Microtask flush must not throw out of the batcher.
    await expect(nextMicrotask()).resolves.toBeUndefined()
    expect(getBatcherStats().droppedSerializationError).toBe(2)
  })

  it('circular payload is caught as a serialization error', async () => {
    const ws = mockWS()
    const cyclic: any = { a: 1 }
    cyclic.self = cyclic
    queueWsMessage(ws as any, { type: 'X', componentId: 'c', payload: cyclic, timestamp: 1 })
    await nextMicrotask()
    expect(getBatcherStats().droppedSerializationError).toBeGreaterThan(0)
    expect(ws.send).not.toHaveBeenCalled()
  })

  it('🔍 BigInt in payload triggers serialization error path', async () => {
    const ws = mockWS()
    queueWsMessage(ws as any, { type: 'X', componentId: 'c', payload: { n: 9999999999999999999n } as any, timestamp: 1 })
    await nextMicrotask()
    expect(getBatcherStats().droppedSerializationError).toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Immediate sends (binary + sync)
// ─────────────────────────────────────────────────────────────────────────

describe('sendImmediate / sendBinaryImmediate', () => {
  it('sendImmediate flushes pending queue first (ordering preserved)', () => {
    const ws = mockWS()
    queueWsMessage(ws as any, { type: 'A', componentId: 'c', payload: { a: 1 }, timestamp: 1 })
    sendImmediate(ws as any, '{"immediate":true}')
    // Two send() calls: first the flushed batch, then the immediate message.
    expect(ws.send).toHaveBeenCalledTimes(2)
    const first = JSON.parse(ws.send.mock.calls[0]![0] as string)
    expect(first.type).toBe('A')
    expect(ws.send.mock.calls[1]![0]).toBe('{"immediate":true}')
  })

  it('sendBinaryImmediate flushes pending queue first', () => {
    const ws = mockWS()
    queueWsMessage(ws as any, { type: 'A', componentId: 'c', payload: { a: 1 }, timestamp: 1 })
    const bin = new Uint8Array([1, 2, 3])
    sendBinaryImmediate(ws as any, bin)
    expect(ws.send).toHaveBeenCalledTimes(2)
    expect(ws.send.mock.calls[1]![0]).toBe(bin)
  })

  it('sendImmediate on closed ws is a counted drop', () => {
    const ws = mockWS()
    ws.readyState = 3
    sendImmediate(ws as any, '{"x":1}')
    expect(getBatcherStats().droppedClosed).toBe(1)
    expect(ws.send).not.toHaveBeenCalled()
  })

  it('sendBinaryImmediate on null ws is no-op', () => {
    expect(() => sendBinaryImmediate(null as any, new Uint8Array(0))).not.toThrow()
    expect(getBatcherStats().droppedClosed).toBe(0)
  })

  it('sendImmediate failure (ws.send throws) increments error counter', () => {
    const ws = mockWS()
    ws.send.mockImplementation(() => { throw new Error('eof') })
    sendImmediate(ws as any, '{"x":1}')
    expect(getBatcherStats().droppedSerializationError).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Pre-serialized + mixed batches
// ─────────────────────────────────────────────────────────────────────────

describe('pre-serialized handling', () => {
  it('single pre-serialized message is sent verbatim', async () => {
    const ws = mockWS()
    queuePreSerialized(ws as any, '{"raw":true}')
    await nextMicrotask()
    expect(ws.send).toHaveBeenCalledWith('{"raw":true}')
  })

  it('multiple pre-serialized messages are wrapped in JSON array without re-parsing', async () => {
    const ws = mockWS()
    queuePreSerialized(ws as any, '{"a":1}')
    queuePreSerialized(ws as any, '{"b":2}')
    await nextMicrotask()
    expect(ws.send).toHaveBeenCalledWith('[{"a":1},{"b":2}]')
  })

  it('mixed pre-serialized + object batch produces a single JSON array', async () => {
    const ws = mockWS()
    queueWsMessage(ws as any, { type: 'O', componentId: 'c', payload: { x: 1 }, timestamp: 1 })
    queuePreSerialized(ws as any, '{"pre":true}')
    await nextMicrotask()
    expect(ws.send).toHaveBeenCalledTimes(1)
    const arr = JSON.parse(ws.send.mock.calls[0]![0] as string)
    expect(arr).toHaveLength(2)
    expect(arr[0].type).toBe('O')
    expect(arr[1].pre).toBe(true)
  })
})
