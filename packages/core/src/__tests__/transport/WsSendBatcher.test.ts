// Tests for WsSendBatcher — message batching, deduplication, backpressure
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { queueWsMessage, queuePreSerialized, sendImmediate } from '../../transport/WsSendBatcher'
import type { GenericWebSocket } from '../../transport/types'
import { MAX_QUEUE_SIZE } from '../../protocol/constants'

function createMockWs(readyState = 1): GenericWebSocket & { _sent: (string | ArrayBuffer | Uint8Array)[] } {
  const sent: (string | ArrayBuffer | Uint8Array)[] = []
  return {
    send: vi.fn((data: string | ArrayBuffer | Uint8Array) => { sent.push(data) }),
    close: vi.fn(),
    data: {} as any,
    remoteAddress: '127.0.0.1',
    readyState: readyState as any,
    _sent: sent,
  } as any
}

function msg(type: string, componentId: string, payload: any = {}): any {
  return { type, componentId, payload, timestamp: Date.now() }
}

// Flush the microtask queue so batched messages are sent
async function flush() {
  await new Promise<void>(r => queueMicrotask(r))
}

describe('WsSendBatcher', () => {
  describe('queueWsMessage', () => {
    it('batches a single message and sends as JSON object', async () => {
      const ws = createMockWs()
      queueWsMessage(ws, msg('STATE_DELTA', 'c1', { delta: { x: 1 } }))

      await flush()

      expect(ws.send).toHaveBeenCalledOnce()
      const sent = JSON.parse(ws._sent[0] as string)
      expect(sent.type).toBe('STATE_DELTA')
    })

    it('batches multiple messages into a JSON array', async () => {
      const ws = createMockWs()
      queueWsMessage(ws, msg('STATE_DELTA', 'c1', { delta: { x: 1 } }))
      queueWsMessage(ws, msg('ACTION_RESPONSE', 'c2', { result: true }))

      await flush()

      expect(ws.send).toHaveBeenCalledOnce()
      const parsed = JSON.parse(ws._sent[0] as string)
      expect(Array.isArray(parsed)).toBe(true)
      expect(parsed).toHaveLength(2)
    })

    it('deduplicates STATE_DELTA for same componentId', async () => {
      const ws = createMockWs()
      queueWsMessage(ws, msg('STATE_DELTA', 'c1', { delta: { x: 1 } }))
      queueWsMessage(ws, msg('STATE_DELTA', 'c1', { delta: { x: 2, y: 10 } }))

      await flush()

      expect(ws.send).toHaveBeenCalledOnce()
      const parsed = JSON.parse(ws._sent[0] as string)
      // Queue had 2 items, deduped to 1 — still sent as array [msg]
      const deduped = Array.isArray(parsed) ? parsed[0] : parsed
      expect(deduped.type).toBe('STATE_DELTA')
      expect(deduped.payload.delta).toEqual({ x: 2, y: 10 })
    })

    it('merges deltas correctly — last write wins per field', async () => {
      const ws = createMockWs()
      queueWsMessage(ws, msg('STATE_DELTA', 'c1', { delta: { a: 1, b: 2 } }))
      queueWsMessage(ws, msg('STATE_DELTA', 'c1', { delta: { b: 3, c: 4 } }))
      queueWsMessage(ws, msg('STATE_DELTA', 'c1', { delta: { a: 10 } }))

      await flush()

      const parsed = JSON.parse(ws._sent[0] as string)
      // Queue had 3 items, deduped to 1 — still sent as array [msg]
      const deduped = Array.isArray(parsed) ? parsed[0] : parsed
      expect(deduped.payload.delta).toEqual({ a: 10, b: 3, c: 4 })
    })

    it('does not deduplicate different componentIds', async () => {
      const ws = createMockWs()
      queueWsMessage(ws, msg('STATE_DELTA', 'c1', { delta: { x: 1 } }))
      queueWsMessage(ws, msg('STATE_DELTA', 'c2', { delta: { x: 2 } }))

      await flush()

      const parsed = JSON.parse(ws._sent[0] as string)
      expect(Array.isArray(parsed)).toBe(true)
      expect(parsed).toHaveLength(2)
    })

    it('does not deduplicate non-STATE_DELTA messages', async () => {
      const ws = createMockWs()
      queueWsMessage(ws, msg('ACTION_RESPONSE', 'c1', { result: 1 }))
      queueWsMessage(ws, msg('ACTION_RESPONSE', 'c1', { result: 2 }))

      await flush()

      const parsed = JSON.parse(ws._sent[0] as string)
      expect(Array.isArray(parsed)).toBe(true)
      expect(parsed).toHaveLength(2)
    })

    it('skips send when ws is not open', async () => {
      const ws = createMockWs(3) // CLOSED
      queueWsMessage(ws, msg('STATE_DELTA', 'c1', { delta: { x: 1 } }))

      await flush()

      expect(ws.send).not.toHaveBeenCalled()
    })

    it('skips send when ws is null-ish', async () => {
      // Should not throw
      queueWsMessage(null as any, msg('STATE_DELTA', 'c1', { delta: { x: 1 } }))
      await flush()
    })

    it('applies backpressure — drops oldest when queue exceeds MAX_QUEUE_SIZE', async () => {
      const ws = createMockWs()

      // Fill queue beyond limit
      for (let i = 0; i < MAX_QUEUE_SIZE + 50; i++) {
        queueWsMessage(ws, msg('ACTION_RESPONSE', `c${i}`, { i }))
      }

      await flush()

      expect(ws.send).toHaveBeenCalledOnce()
      const parsed = JSON.parse(ws._sent[0] as string)
      // Should have exactly MAX_QUEUE_SIZE messages (oldest 50 were dropped)
      expect(parsed.length).toBe(MAX_QUEUE_SIZE)
    })
  })

  describe('queuePreSerialized', () => {
    it('sends a single pre-serialized string directly', async () => {
      const ws = createMockWs()
      const serialized = JSON.stringify({ type: 'ROOM_EVENT', roomId: 'r1' })

      queuePreSerialized(ws, serialized)
      await flush()

      expect(ws.send).toHaveBeenCalledOnce()
      expect(ws._sent[0]).toBe(serialized)
    })

    it('wraps multiple pre-serialized strings in array brackets', async () => {
      const ws = createMockWs()
      const s1 = JSON.stringify({ type: 'ROOM_EVENT', roomId: 'r1' })
      const s2 = JSON.stringify({ type: 'ROOM_STATE', roomId: 'r2' })

      queuePreSerialized(ws, s1)
      queuePreSerialized(ws, s2)
      await flush()

      expect(ws.send).toHaveBeenCalledOnce()
      const sent = ws._sent[0] as string
      expect(sent).toBe(`[${s1},${s2}]`)
    })

    it('skips send for closed ws', async () => {
      const ws = createMockWs(0) // CONNECTING
      queuePreSerialized(ws, '{"test":true}')
      await flush()
      expect(ws.send).not.toHaveBeenCalled()
    })
  })

  describe('mixed queuing', () => {
    it('combines objects and pre-serialized strings into single array', async () => {
      const ws = createMockWs()
      queueWsMessage(ws, msg('STATE_DELTA', 'c1', { delta: { x: 1 } }))
      queuePreSerialized(ws, JSON.stringify({ type: 'ROOM_EVENT', roomId: 'r1' }))

      await flush()

      expect(ws.send).toHaveBeenCalledOnce()
      const sent = ws._sent[0] as string
      const parsed = JSON.parse(sent)
      expect(Array.isArray(parsed)).toBe(true)
      expect(parsed).toHaveLength(2)
    })
  })

  describe('sendImmediate', () => {
    it('sends data immediately without batching', () => {
      const ws = createMockWs()
      sendImmediate(ws, '{"type":"ACTION_RESPONSE"}')

      // No need to flush — sent immediately
      expect(ws.send).toHaveBeenCalledOnce()
      expect(ws._sent[0]).toBe('{"type":"ACTION_RESPONSE"}')
    })

    it('does not send when ws is closed', () => {
      const ws = createMockWs(3)
      sendImmediate(ws, '{"type":"ACTION_RESPONSE"}')
      expect(ws.send).not.toHaveBeenCalled()
    })

    it('does not send when ws is null', () => {
      // Should not throw
      sendImmediate(null as any, '{"test":true}')
    })
  })

  describe('multiple connections', () => {
    it('batches messages independently per WebSocket', async () => {
      const ws1 = createMockWs()
      const ws2 = createMockWs()

      queueWsMessage(ws1, msg('STATE_DELTA', 'c1', { delta: { a: 1 } }))
      queueWsMessage(ws2, msg('STATE_DELTA', 'c2', { delta: { b: 2 } }))

      await flush()

      expect(ws1.send).toHaveBeenCalledOnce()
      expect(ws2.send).toHaveBeenCalledOnce()

      const p1 = JSON.parse(ws1._sent[0] as string)
      const p2 = JSON.parse(ws2._sent[0] as string)

      expect(p1.payload.delta).toEqual({ a: 1 })
      expect(p2.payload.delta).toEqual({ b: 2 })
    })
  })

  describe('connection closed between queue and flush', () => {
    it('does not throw when ws closes before flush', async () => {
      const ws = createMockWs()
      queueWsMessage(ws, msg('STATE_DELTA', 'c1', { delta: { x: 1 } }))

      // Close ws before flush
      ;(ws as any).readyState = 3

      await flush()

      // Should not have sent anything (readyState checked at flush time)
      expect(ws.send).not.toHaveBeenCalled()
    })
  })
})

