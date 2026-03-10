// Tests for $options.deepDiff — deep diff of plain objects in setState()
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

/** Wait for WsSendBatcher microtask flush */
const flush = () => new Promise<void>(r => queueMicrotask(r))

/** Extract STATE_DELTA payloads from ws.send mock calls */
function extractDeltas(ws: FluxStackWebSocket): any[] {
  const deltas: any[] = []
  for (const call of (ws.send as any).mock.calls) {
    try {
      const parsed = JSON.parse(call[0])
      const messages = Array.isArray(parsed) ? parsed : [parsed]
      for (const msg of messages) {
        if (msg.type === 'STATE_DELTA') {
          deltas.push(msg.payload.delta)
        }
      }
    } catch {}
  }
  return deltas
}

// ===== Components =====

type DeepState = {
  scores: { red: number; blue: number }
  settings: { volume: number; difficulty: string }
  items: string[]
  count: number
  nested: { a: { b: { c: number; d: number } } }
}

class DeepDiffComponent extends LiveComponent<DeepState> {
  static componentName = 'DeepDiffComponent'
  static publicActions = [] as const
  static $options = { deepDiff: true }
  static defaultState: DeepState = {
    scores: { red: 0, blue: 0 },
    settings: { volume: 50, difficulty: 'normal' },
    items: ['a'],
    count: 0,
    nested: { a: { b: { c: 1, d: 2 } } },
  }
}

class ShallowComponent extends LiveComponent<DeepState> {
  static componentName = 'ShallowComponent'
  static publicActions = [] as const
  // No $options — shallow diff (default)
  static defaultState: DeepState = {
    scores: { red: 0, blue: 0 },
    settings: { volume: 50, difficulty: 'normal' },
    items: ['a'],
    count: 0,
    nested: { a: { b: { c: 1, d: 2 } } },
  }
}

describe('ComponentStateManager deepDiff', () => {
  // ===== Deep Diff Enabled =====

  describe('with deepDiff: true', () => {
    it('sends only changed nested fields', async () => {
      const ws = createMockWs()
      const comp = new DeepDiffComponent({}, ws)

      comp.setState({ scores: { red: 0, blue: 5 } })
      await flush()

      const deltas = extractDeltas(ws)
      expect(deltas.length).toBe(1)
      // Only blue changed — red should NOT be in the delta
      expect(deltas[0]).toEqual({ scores: { blue: 5 } })
    })

    it('sends nothing when nested values are identical', async () => {
      const ws = createMockWs()
      const comp = new DeepDiffComponent({}, ws)

      comp.setState({ scores: { red: 0, blue: 0 } })
      await flush()

      const deltas = extractDeltas(ws)
      expect(deltas.length).toBe(0)
    })

    it('handles primitive changes normally', async () => {
      const ws = createMockWs()
      const comp = new DeepDiffComponent({}, ws)

      comp.setState({ count: 42 })
      await flush()

      const deltas = extractDeltas(ws)
      expect(deltas.length).toBe(1)
      expect(deltas[0]).toEqual({ count: 42 })
    })

    it('does not diff primitives that are equal', async () => {
      const ws = createMockWs()
      const comp = new DeepDiffComponent({}, ws)

      comp.setState({ count: 0 }) // same as default
      await flush()

      const deltas = extractDeltas(ws)
      expect(deltas.length).toBe(0)
    })

    it('sends full array on reference change (no deep array diff)', async () => {
      const ws = createMockWs()
      const comp = new DeepDiffComponent({}, ws)

      comp.setState({ items: ['a', 'b'] })
      await flush()

      const deltas = extractDeltas(ws)
      expect(deltas.length).toBe(1)
      expect(deltas[0]).toEqual({ items: ['a', 'b'] })
    })

    it('deep diffs nested objects up to 3 levels', async () => {
      const ws = createMockWs()
      const comp = new DeepDiffComponent({}, ws)

      // Change c (depth 3: nested.a.b.c) — should be diffed
      comp.setState({ nested: { a: { b: { c: 99, d: 2 } } } })
      await flush()

      const deltas = extractDeltas(ws)
      expect(deltas.length).toBe(1)
      expect(deltas[0]).toEqual({ nested: { a: { b: { c: 99 } } } })
    })

    it('maintains internal state correctly after deep diff', async () => {
      const ws = createMockWs()
      const comp = new DeepDiffComponent({}, ws)

      comp.setState({ scores: { red: 10, blue: 0 } })
      await flush()

      // Reset mock to capture only second setState
      ;(ws.send as any).mockClear()

      // Now only change blue — red should still be 10
      comp.setState({ scores: { red: 10, blue: 7 } })
      await flush()

      const deltas = extractDeltas(ws)
      expect(deltas.length).toBe(1)
      expect(deltas[0]).toEqual({ scores: { blue: 7 } })

      // Verify internal state has both values
      expect(comp.getSerializableState().scores).toEqual({ red: 10, blue: 7 })
    })

    it('handles multiple fields changing at once', async () => {
      const ws = createMockWs()
      const comp = new DeepDiffComponent({}, ws)

      comp.setState({
        scores: { red: 1, blue: 0 },
        count: 5,
        settings: { volume: 50, difficulty: 'hard' },
      })
      await flush()

      const deltas = extractDeltas(ws)
      expect(deltas.length).toBe(1)
      expect(deltas[0]).toEqual({
        scores: { red: 1 },
        count: 5,
        settings: { difficulty: 'hard' },
      })
    })

    it('works with functional setState', async () => {
      const ws = createMockWs()
      const comp = new DeepDiffComponent({}, ws)

      comp.setState(prev => ({
        scores: { red: prev.scores.red + 1, blue: prev.scores.blue },
      }))
      await flush()

      const deltas = extractDeltas(ws)
      expect(deltas.length).toBe(1)
      expect(deltas[0]).toEqual({ scores: { red: 1 } })
    })
  })

  // ===== Shallow Diff (default, no $options) =====

  describe('with deepDiff: false (default)', () => {
    it('sends entire object even if nested values are same', async () => {
      const ws = createMockWs()
      const comp = new ShallowComponent({}, ws)

      // New object reference with only blue changed
      comp.setState({ scores: { red: 0, blue: 5 } })
      await flush()

      const deltas = extractDeltas(ws)
      expect(deltas.length).toBe(1)
      // Shallow: the whole object is sent (reference changed)
      expect(deltas[0]).toEqual({ scores: { red: 0, blue: 5 } })
    })

    it('does not send when same reference', async () => {
      const ws = createMockWs()
      const comp = new ShallowComponent({}, ws)

      // Same reference — should be no-op
      const currentScores = comp.getSerializableState().scores
      comp.setState({ scores: currentScores })
      await flush()

      const deltas = extractDeltas(ws)
      expect(deltas.length).toBe(0)
    })
  })
})
