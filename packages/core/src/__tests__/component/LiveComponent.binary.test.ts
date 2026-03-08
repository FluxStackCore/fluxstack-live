// Tests for sendBinaryDelta() binary transport and wire format
import { describe, it, expect, vi } from 'vitest'
import { LiveComponent } from '../../component/LiveComponent'
import type { FluxStackWebSocket } from '../../transport/types'

// Minimal mock WS
function createMockWs(): FluxStackWebSocket {
  return {
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1,
    data: {} as any,
    remoteAddress: '127.0.0.1',
  } as any
}

// Simple test encoder: just JSON-encodes the delta into bytes
function testEncoder(delta: Record<string, any>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(delta))
}

// Simple test decoder: reverses testEncoder
function testDecoder(buffer: Uint8Array): Record<string, any> {
  return JSON.parse(new TextDecoder().decode(buffer))
}

class TestComponent extends LiveComponent<{ x: number; y: number; name: string }> {
  static componentName = 'TestBinaryComponent'
  static publicActions = ['doSomething'] as const
  static defaultState = { x: 0, y: 0, name: 'test' }

  async doSomething() {
    return { success: true }
  }
}

describe('LiveComponent.sendBinaryDelta', () => {
  it('sends binary frame with correct wire format [0x01][idLen][id][payload]', () => {
    const ws = createMockWs()
    const comp = new TestComponent({}, ws)

    comp.sendBinaryDelta({ x: 42, y: 99 }, testEncoder)

    expect(ws.send).toHaveBeenCalledOnce()
    const frame: Uint8Array = (ws.send as any).mock.calls[0][0]

    // Type byte
    expect(frame[0]).toBe(0x01)

    // Component ID length
    const idLen = frame[1]
    expect(idLen).toBeGreaterThan(0)

    // Component ID
    const id = new TextDecoder().decode(frame.subarray(2, 2 + idLen))
    expect(id).toBe(comp.id)

    // Payload
    const payload = frame.subarray(2 + idLen)
    const decoded = testDecoder(payload)
    expect(decoded).toEqual({ x: 42, y: 99 })
  })

  it('updates internal state', () => {
    const ws = createMockWs()
    const comp = new TestComponent({}, ws)

    expect(comp.state.x).toBe(0)
    comp.sendBinaryDelta({ x: 10 }, testEncoder)
    expect(comp.state.x).toBe(10)
    expect(comp.state.y).toBe(0) // unchanged
  })

  it('skips send when no actual changes', () => {
    const ws = createMockWs()
    const comp = new TestComponent({}, ws)

    // Send with same values as default
    comp.sendBinaryDelta({ x: 0, y: 0 }, testEncoder)
    expect(ws.send).not.toHaveBeenCalled()
  })

  it('does not send when ws is not open (readyState !== 1)', () => {
    const ws = createMockWs()
    ;(ws as any).readyState = 3 // CLOSED
    const comp = new TestComponent({}, ws)

    comp.sendBinaryDelta({ x: 5 }, testEncoder)

    // State should still update
    expect(comp.state.x).toBe(5)
    // But no send
    expect(ws.send).not.toHaveBeenCalled()
  })

  it('binary frame can be parsed back by matching client logic', () => {
    const ws = createMockWs()
    const comp = new TestComponent({}, ws)

    comp.sendBinaryDelta({ x: 123, y: 456 }, testEncoder)

    const frame: Uint8Array = (ws.send as any).mock.calls[0][0]

    // Parse the frame like the client would
    expect(frame[0]).toBe(0x01)
    const idLen = frame[1]
    const componentId = new TextDecoder().decode(frame.subarray(2, 2 + idLen))
    const payload = frame.subarray(2 + idLen)
    const delta = testDecoder(payload)

    expect(componentId).toBe(comp.id)
    expect(delta.x).toBe(123)
    expect(delta.y).toBe(456)
  })

  it('handles multiple sequential sends correctly', () => {
    const ws = createMockWs()
    const comp = new TestComponent({}, ws)

    comp.sendBinaryDelta({ x: 1 }, testEncoder)
    comp.sendBinaryDelta({ x: 2 }, testEncoder)
    comp.sendBinaryDelta({ y: 10 }, testEncoder)

    expect(ws.send).toHaveBeenCalledTimes(3)
    expect(comp.state.x).toBe(2)
    expect(comp.state.y).toBe(10)
  })

  it('only includes changed fields in the encoded payload', () => {
    const ws = createMockWs()
    const comp = new TestComponent({}, ws)

    // First set x to something
    comp.sendBinaryDelta({ x: 5, y: 10 }, testEncoder)

    // Now send same x again but different y
    comp.sendBinaryDelta({ x: 5, y: 20 }, testEncoder)

    // Second call: x=5 hasn't changed (still 5), so only y should be in payload
    const frame: Uint8Array = (ws.send as any).mock.calls[1][0]
    const idLen = frame[1]
    const payload = frame.subarray(2 + idLen)
    const delta = testDecoder(payload)

    expect(delta).toEqual({ y: 20 })
    expect(delta.x).toBeUndefined()
  })
})
