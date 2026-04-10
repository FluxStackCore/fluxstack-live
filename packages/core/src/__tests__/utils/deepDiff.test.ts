// Tests for computeDeepDiff and deepAssign — key removal detection
// Covers issue FluxStackCore/fluxstack-live#1
import { describe, it, expect } from 'vitest'
import { computeDeepDiff, deepAssign } from '../../utils/deepDiff'

describe('computeDeepDiff', () => {
  describe('key removal detection', () => {
    it('detects removed keys in nested objects', () => {
      const prev = { players: { A: { score: 1 }, B: { score: 2 } } }
      const next = { players: { A: { score: 1 } } }

      const diff = computeDeepDiff(prev, next)
      expect(diff).toEqual({ players: { B: null } })
    })

    it('does NOT treat missing top-level keys as removals (partial update)', () => {
      const prev = { score: 10, round: 1, name: 'test' }
      const next = { score: 20 }

      const diff = computeDeepDiff(prev, next)
      // Only score changed; round and name are not in next but that's
      // because this is a partial update, not a removal
      expect(diff).toEqual({ score: 20 })
    })

    it('detects removal alongside changes in nested object', () => {
      const prev = { data: { a: 1, b: 2, c: 3 } }
      const next = { data: { a: 10, c: 3 } }

      const diff = computeDeepDiff(prev, next)
      expect(diff).toEqual({ data: { a: 10, b: null } })
    })

    it('detects all keys removed from nested object', () => {
      const prev = { users: { alice: { online: true }, bob: { online: true } } }
      const next = { users: {} }

      const diff = computeDeepDiff(prev, next)
      expect(diff).toEqual({ users: { alice: null, bob: null } })
    })

    it('detects removal in deeply nested objects', () => {
      const prev = { level1: { level2: { a: 1, b: 2 } } }
      const next = { level1: { level2: { a: 1 } } }

      const diff = computeDeepDiff(prev, next)
      expect(diff).toEqual({ level1: { level2: { b: null } } })
    })

    it('returns null when nested objects are identical', () => {
      const prev = { players: { A: { score: 1 } } }
      const next = { players: { A: { score: 1 } } }

      const diff = computeDeepDiff(prev, next)
      expect(diff).toBeNull()
    })

    it('handles mixed additions, changes, and removals', () => {
      const prev = { items: { x: 1, y: 2, z: 3 } }
      const next = { items: { x: 10, w: 4 } }

      const diff = computeDeepDiff(prev, next)
      expect(diff).toEqual({
        items: { x: 10, w: 4, y: null, z: null },
      })
    })

    it('handles nested object replaced by primitive (not a removal)', () => {
      const prev = { config: { nested: { a: 1 } } }
      const next = { config: 'reset' as any }

      const diff = computeDeepDiff(prev, next)
      expect(diff).toEqual({ config: 'reset' })
    })

    it('handles removal in Record<string, T> pattern (game room scenario)', () => {
      // Simulates the exact scenario from the issue:
      // player B leaves a game room
      const prev = {
        players: {
          A: { name: 'Alice', x: 0, y: 0 },
          B: { name: 'Bob', x: 5, y: 5 },
        },
      }
      const next = {
        players: {
          A: { name: 'Alice', x: 1, y: 0 },
        },
      }

      const diff = computeDeepDiff(prev, next)
      expect(diff).toEqual({
        players: {
          A: { x: 1 },
          B: null,
        },
      })
    })
  })

  describe('existing behavior preserved', () => {
    it('detects no changes', () => {
      const prev = { a: 1, b: 'hello' }
      const next = { a: 1, b: 'hello' }
      expect(computeDeepDiff(prev, next)).toBeNull()
    })

    it('detects primitive changes', () => {
      const prev = { a: 1, b: 2 }
      const next = { a: 1, b: 3 }
      expect(computeDeepDiff(prev, next)).toEqual({ b: 3 })
    })

    it('detects new keys added', () => {
      const prev = { a: 1 }
      const next = { a: 1, b: 2 }
      expect(computeDeepDiff(prev, next)).toEqual({ b: 2 })
    })

    it('detects nested object changes', () => {
      const prev = { nested: { x: 1, y: 2 } }
      const next = { nested: { x: 1, y: 3 } }
      expect(computeDeepDiff(prev, next)).toEqual({ nested: { y: 3 } })
    })

    it('respects maxDepth', () => {
      const prev = { a: { b: { c: { d: 1 } } } }
      const next = { a: { b: { c: { d: 2 } } } }
      // maxDepth=2: at depth 3, falls back to reference equality
      const diff = computeDeepDiff(prev, next, 0, 2)
      expect(diff).toEqual({ a: { b: { c: { d: 2 } } } })
    })
  })
})

describe('deepAssign', () => {
  describe('null semantics (top-level = value, nested = deletion)', () => {
    // Fixes #6: null at the top level is a real value, not a delete signal.
    // The delete semantics still apply inside nested objects where
    // computeDeepDiff uses null as the "removed key" sentinel for
    // Record<string, T> maps (issue #1/#3).

    it('top-level null sets the key to null (not deletion)', () => {
      const target: Record<string, unknown> = { a: 1, b: 2, c: 3 }
      deepAssign(target, { b: null })
      expect(target).toEqual({ a: 1, b: null, c: 3 })
      expect('b' in target).toBe(true)
      expect(target.b).toBeNull()
    })

    it('nested null deletes the key (from computeDeepDiff sentinel)', () => {
      const target = { players: { A: { score: 1 }, B: { score: 2 } } }
      deepAssign(target, { players: { B: null } })
      expect(target).toEqual({ players: { A: { score: 1 } } })
      expect('B' in target.players).toBe(false)
    })

    it('mixes top-level null-as-value with nested null-as-deletion', () => {
      const target: Record<string, unknown> = {
        selected: { id: 'x' },
        players: { A: { score: 1 }, B: { score: 2 } },
      }
      deepAssign(target, {
        selected: null,            // top-level → set to null
        players: { B: null },      // nested → delete B
      } as any)
      expect(target).toEqual({
        selected: null,
        players: { A: { score: 1 } },
      })
      expect('selected' in target).toBe(true)
      expect('B' in (target.players as any)).toBe(false)
    })

    it('top-level null overwrites a non-object value', () => {
      const target = { name: 'alice' as string | null }
      deepAssign(target, { name: null })
      expect(target.name).toBeNull()
    })

    it('top-level null overwrites a plain-object value (replaces, does not merge)', () => {
      const target = { settings: { volume: 5 } as { volume: number } | null }
      deepAssign(target, { settings: null })
      expect(target.settings).toBeNull()
    })

    it('applies full round-trip: diff then assign', () => {
      // Simulate the full flow: compute diff, then apply it
      const state = {
        players: {
          A: { name: 'Alice', x: 0 },
          B: { name: 'Bob', x: 5 },
        },
      }
      const update = {
        players: {
          A: { name: 'Alice', x: 1 },
        },
      }

      const diff = computeDeepDiff(state, update)!
      expect(diff).not.toBeNull()

      deepAssign(state, diff)
      expect(state).toEqual({
        players: {
          A: { name: 'Alice', x: 1 },
        },
      })
      expect('B' in state.players).toBe(false)
    })
  })

  describe('undefined is a no-op (fixes #6 server↔wire drift)', () => {
    // JSON.stringify strips `undefined`, so if the server accepted it we
    // would silently desync from the client. deepAssign now skips it.

    it('top-level undefined does not change the target', () => {
      const target: Record<string, unknown> = { a: 1, b: 2 }
      deepAssign(target, { a: undefined })
      expect(target).toEqual({ a: 1, b: 2 })
    })

    it('nested undefined does not change the target', () => {
      const target = { settings: { volume: 5, mute: false } }
      deepAssign(target, { settings: { volume: undefined } } as any)
      expect(target).toEqual({ settings: { volume: 5, mute: false } })
    })

    it('undefined mixed with real updates applies only the real ones', () => {
      const target: Record<string, unknown> = { a: 1, b: 2, c: 3 }
      deepAssign(target, { a: 10, b: undefined, d: 4 } as any)
      expect(target).toEqual({ a: 10, b: 2, c: 3, d: 4 })
    })
  })

  describe('existing behavior preserved', () => {
    it('merges plain objects recursively', () => {
      const target = { a: { x: 1, y: 2 }, b: 3 }
      deepAssign(target, { a: { y: 5 } })
      expect(target).toEqual({ a: { x: 1, y: 5 }, b: 3 })
    })

    it('overwrites non-object values', () => {
      const target = { a: 1, b: 'old' }
      deepAssign(target, { a: 2, b: 'new' })
      expect(target).toEqual({ a: 2, b: 'new' })
    })

    it('adds new keys', () => {
      const target = { a: 1 } as any
      deepAssign(target, { b: 2 })
      expect(target).toEqual({ a: 1, b: 2 })
    })
  })
})

describe('computeDeepDiff — undefined handling (fixes #6)', () => {
  it('skips undefined values in the update (never emits them)', () => {
    const prev = { a: 1, b: 2 }
    const next = { a: 10, b: undefined } as any
    const diff = computeDeepDiff(prev, next)
    expect(diff).toEqual({ a: 10 })
    expect(diff).not.toHaveProperty('b')
  })

  it('top-level null is emitted normally (real value, not a removal)', () => {
    const prev = { selected: { id: 'x' } as { id: string } | null }
    const next = { selected: null }
    const diff = computeDeepDiff(prev as any, next as any)
    expect(diff).toEqual({ selected: null })
  })

  it('top-level null is unchanged if prev was already null', () => {
    const prev = { selected: null }
    const next = { selected: null }
    const diff = computeDeepDiff(prev as any, next as any)
    expect(diff).toBeNull()
  })
})
