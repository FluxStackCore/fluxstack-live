/**
 * deepDiff & deepAssign — Environment & Edge-Case Tests
 *
 * Covers scenarios NOT in the existing unit/regression suites:
 *   - Special JS types: Date, RegExp, Map, Set, Typed Arrays, Error
 *   - Array mutations: nested arrays, mixed types, sparse arrays
 *   - Empty/degenerate states: empty objects, empty nested, single-key
 *   - Prototype pollution resilience
 *   - Very wide objects (100+ keys)
 *   - Very deep nesting (beyond maxDepth)
 *   - Mixed-type transitions (object → array, number → object, etc.)
 *   - NaN, Infinity, -0 handling
 *   - Symbol / non-enumerable keys (should be ignored)
 *   - Real-world domain simulations: IoT, chat, dashboard, e-commerce
 *   - Round-trip idempotency (diff → assign → diff === null)
 *   - Concurrent multi-entity updates
 */

import { describe, it, expect } from 'vitest'
import { computeDeepDiff, deepAssign, isPlainObject } from '../../utils/deepDiff'

// ─── Helpers ────────────────────────────────────────────────────────────────

function clone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj))
}

/** Apply diff to state and return the new state */
function applyDiff(state: Record<string, unknown>, diff: Record<string, unknown> | null) {
  if (!diff) return state
  const copy = clone(state)
  deepAssign(copy, diff)
  return copy
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. isPlainObject edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe('isPlainObject', () => {
  it('returns true for literal objects', () => {
    expect(isPlainObject({})).toBe(true)
    expect(isPlainObject({ a: 1 })).toBe(true)
    expect(isPlainObject(Object.create(Object.prototype))).toBe(true)
  })

  it('returns false for arrays', () => {
    expect(isPlainObject([])).toBe(false)
    expect(isPlainObject([1, 2, 3])).toBe(false)
  })

  it('returns false for null', () => {
    expect(isPlainObject(null)).toBe(false)
  })

  it('returns false for class instances', () => {
    expect(isPlainObject(new Date())).toBe(false)
    expect(isPlainObject(new Map())).toBe(false)
    expect(isPlainObject(new Set())).toBe(false)
    expect(isPlainObject(/regex/)).toBe(false)
    expect(isPlainObject(new Error('test'))).toBe(false)
  })

  it('returns false for primitives', () => {
    expect(isPlainObject(42)).toBe(false)
    expect(isPlainObject('string')).toBe(false)
    expect(isPlainObject(true)).toBe(false)
    expect(isPlainObject(undefined)).toBe(false)
    expect(isPlainObject(Symbol())).toBe(false)
    expect(isPlainObject(BigInt(42))).toBe(false)
  })

  it('returns false for Object.create(null)', () => {
    // null-prototype objects are not "plain" by our definition
    expect(isPlainObject(Object.create(null))).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. Special JS types — treated as opaque values (reference equality)
// ═══════════════════════════════════════════════════════════════════════════

describe('computeDeepDiff — special JS types', () => {
  it('Date: same timestamp, different instances → detected as change', () => {
    const d1 = new Date('2025-01-01')
    const d2 = new Date('2025-01-01')
    const prev = { createdAt: d1 }
    const next = { createdAt: d2 }
    // Different references → diff emits the new value
    const diff = computeDeepDiff(prev, next)
    expect(diff).toEqual({ createdAt: d2 })
  })

  it('Date: same reference → no change', () => {
    const d = new Date('2025-01-01')
    const prev = { createdAt: d }
    const next = { createdAt: d }
    expect(computeDeepDiff(prev, next)).toBeNull()
  })

  it('RegExp: different instances with same pattern → detected as change', () => {
    const prev = { pattern: /abc/i }
    const next = { pattern: /abc/i }
    const diff = computeDeepDiff(prev as any, next as any)
    expect(diff).toEqual({ pattern: /abc/i })
  })

  it('Map and Set are treated as opaque (not deeply diffed)', () => {
    const m1 = new Map([['a', 1]])
    const m2 = new Map([['a', 1]])
    const prev = { data: m1 }
    const next = { data: m2 }
    const diff = computeDeepDiff(prev as any, next as any)
    // Different references → full replacement
    expect(diff).toEqual({ data: m2 })
  })

  it('TypedArray: different instances → detected as change', () => {
    const a = new Uint8Array([1, 2, 3])
    const b = new Uint8Array([1, 2, 3])
    const prev = { buffer: a }
    const next = { buffer: b }
    const diff = computeDeepDiff(prev as any, next as any)
    expect(diff).toEqual({ buffer: b })
  })

  it('Error objects are treated as opaque', () => {
    const e1 = new Error('fail')
    const e2 = new Error('fail')
    const prev = { err: e1 }
    const next = { err: e2 }
    const diff = computeDeepDiff(prev as any, next as any)
    expect(diff).toEqual({ err: e2 })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. Array handling — reference-compared, not deep-diffed
// ═══════════════════════════════════════════════════════════════════════════

describe('computeDeepDiff — arrays', () => {
  it('same array reference → no change', () => {
    const arr = [1, 2, 3]
    const prev = { items: arr }
    const next = { items: arr }
    expect(computeDeepDiff(prev, next)).toBeNull()
  })

  it('new array reference with same content → detected as change', () => {
    const prev = { items: [1, 2, 3] }
    const next = { items: [1, 2, 3] }
    const diff = computeDeepDiff(prev, next)
    expect(diff).toEqual({ items: [1, 2, 3] })
  })

  it('array with added element → full replacement', () => {
    const prev = { tags: ['a', 'b'] }
    const next = { tags: ['a', 'b', 'c'] }
    const diff = computeDeepDiff(prev, next)
    expect(diff).toEqual({ tags: ['a', 'b', 'c'] })
  })

  it('array with removed element → full replacement', () => {
    const prev = { tags: ['a', 'b', 'c'] }
    const next = { tags: ['a', 'c'] }
    const diff = computeDeepDiff(prev, next)
    expect(diff).toEqual({ tags: ['a', 'c'] })
  })

  it('empty array to non-empty → detected', () => {
    const prev = { list: [] as number[] }
    const next = { list: [1] }
    expect(computeDeepDiff(prev, next)).toEqual({ list: [1] })
  })

  it('non-empty array to empty → detected', () => {
    const prev = { list: [1, 2] }
    const next = { list: [] as number[] }
    expect(computeDeepDiff(prev, next)).toEqual({ list: [] })
  })

  it('nested arrays inside objects → full replacement on change', () => {
    const prev = { config: { ports: [80, 443] } }
    const next = { config: { ports: [80, 443, 8080] } }
    const diff = computeDeepDiff(prev, next)
    expect(diff).toEqual({ config: { ports: [80, 443, 8080] } })
  })

  it('array of objects → full replacement (not deep-diffed)', () => {
    const prev = { users: [{ id: 1, name: 'A' }] }
    const next = { users: [{ id: 1, name: 'B' }] }
    const diff = computeDeepDiff(prev, next)
    expect(diff).toEqual({ users: [{ id: 1, name: 'B' }] })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. Empty & degenerate states
// ═══════════════════════════════════════════════════════════════════════════

describe('computeDeepDiff — empty & degenerate states', () => {
  it('both empty objects → null', () => {
    expect(computeDeepDiff({}, {})).toBeNull()
  })

  it('prev empty, next has keys → returns all new keys', () => {
    const diff = computeDeepDiff({}, { a: 1, b: 'hello' })
    expect(diff).toEqual({ a: 1, b: 'hello' })
  })

  it('prev has keys, next empty (top-level) → null (partial update semantics)', () => {
    // At depth 0, missing keys are NOT removals
    const diff = computeDeepDiff({ a: 1, b: 2 }, {})
    expect(diff).toBeNull()
  })

  it('nested: prev has keys, next empty → all keys removed', () => {
    const prev = { data: { x: 1, y: 2 } }
    const next = { data: {} }
    const diff = computeDeepDiff(prev, next)
    expect(diff).toEqual({ data: { x: null, y: null } })
  })

  it('single key, no change → null', () => {
    expect(computeDeepDiff({ x: 42 }, { x: 42 })).toBeNull()
  })

  it('single key, changed → returns diff', () => {
    expect(computeDeepDiff({ x: 42 }, { x: 99 })).toEqual({ x: 99 })
  })

  it('nested empty objects → null', () => {
    expect(computeDeepDiff({ a: {} }, { a: {} })).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. NaN, Infinity, -0
// ═══════════════════════════════════════════════════════════════════════════

describe('computeDeepDiff — numeric edge cases', () => {
  it('NaN === NaN is false → detected as change every time', () => {
    const prev = { value: NaN }
    const next = { value: NaN }
    // NaN !== NaN, so computeDeepDiff sees them as different
    const diff = computeDeepDiff(prev, next)
    expect(diff).toEqual({ value: NaN })
  })

  it('Infinity → same reference → no change', () => {
    const prev = { limit: Infinity }
    const next = { limit: Infinity }
    expect(computeDeepDiff(prev, next)).toBeNull()
  })

  it('-Infinity → same reference → no change', () => {
    const prev = { limit: -Infinity }
    const next = { limit: -Infinity }
    expect(computeDeepDiff(prev, next)).toBeNull()
  })

  it('+0 vs -0 → treated as same (=== is true)', () => {
    const prev = { x: +0 }
    const next = { x: -0 }
    // In JS, +0 === -0 is true
    expect(computeDeepDiff(prev, next)).toBeNull()
  })

  it('number to NaN → detected', () => {
    const prev = { val: 42 }
    const next = { val: NaN }
    const diff = computeDeepDiff(prev, next)
    expect(diff).toEqual({ val: NaN })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. Type transitions (object → primitive, primitive → object, etc.)
// ═══════════════════════════════════════════════════════════════════════════

describe('computeDeepDiff — type transitions', () => {
  it('object → string', () => {
    const prev = { field: { nested: 1 } }
    const next = { field: 'collapsed' as any }
    expect(computeDeepDiff(prev, next)).toEqual({ field: 'collapsed' })
  })

  it('string → object', () => {
    const prev = { field: 'collapsed' as any }
    const next = { field: { nested: 1 } }
    expect(computeDeepDiff(prev, next)).toEqual({ field: { nested: 1 } })
  })

  it('number → object', () => {
    const prev = { count: 5 as any }
    const next = { count: { value: 5, max: 100 } }
    expect(computeDeepDiff(prev, next)).toEqual({ count: { value: 5, max: 100 } })
  })

  it('object → array', () => {
    const prev = { data: { a: 1 } }
    const next = { data: [1, 2] as any }
    expect(computeDeepDiff(prev, next)).toEqual({ data: [1, 2] })
  })

  it('array → object', () => {
    const prev = { data: [1, 2] as any }
    const next = { data: { a: 1 } }
    expect(computeDeepDiff(prev, next)).toEqual({ data: { a: 1 } })
  })

  it('boolean → object', () => {
    const prev = { active: true as any }
    const next = { active: { since: '2025-01-01' } }
    expect(computeDeepDiff(prev, next)).toEqual({ active: { since: '2025-01-01' } })
  })

  it('null → object', () => {
    const prev = { config: null as any }
    const next = { config: { theme: 'dark' } }
    expect(computeDeepDiff(prev, next)).toEqual({ config: { theme: 'dark' } })
  })

  it('object → null (top-level)', () => {
    const prev = { config: { theme: 'dark' } }
    const next = { config: null as any }
    expect(computeDeepDiff(prev, next)).toEqual({ config: null })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 7. Prototype pollution resilience
// ═══════════════════════════════════════════════════════════════════════════

describe('computeDeepDiff — prototype pollution resilience', () => {
  it('ignores __proto__ in next if present as own key', () => {
    const prev = { safe: 1 }
    const next = JSON.parse('{"safe": 2, "__proto__": {"polluted": true}}')
    const diff = computeDeepDiff(prev, next)
    // __proto__ parsed by JSON.parse becomes an own property, so diff picks it up,
    // but it must not pollute Object.prototype
    expect(({} as any).polluted).toBeUndefined()
    expect(diff?.safe).toBe(2)
  })

  it('ignores constructor in next', () => {
    const prev = { a: 1 }
    const next = { a: 2, constructor: { prototype: { hacked: true } } } as any
    const diff = computeDeepDiff(prev, next)
    expect(diff).toHaveProperty('a', 2)
    expect(({} as any).hacked).toBeUndefined()
  })
})

describe('deepAssign — prototype pollution resilience', () => {
  it('does not pollute Object.prototype via __proto__', () => {
    const target = { a: 1 }
    const source = JSON.parse('{"__proto__": {"polluted": true}}')
    deepAssign(target, source)
    expect(({} as any).polluted).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 8. Symbol & non-enumerable keys
// ═══════════════════════════════════════════════════════════════════════════

describe('computeDeepDiff — non-enumerable & symbol keys', () => {
  it('ignores symbol keys (Object.keys does not return them)', () => {
    const sym = Symbol('hidden')
    const prev = { a: 1 } as any
    prev[sym] = 'old'
    const next = { a: 1 } as any
    next[sym] = 'new'
    // Symbol keys are not returned by Object.keys, so no diff
    expect(computeDeepDiff(prev, next)).toBeNull()
  })

  it('ignores non-enumerable keys', () => {
    const prev = Object.defineProperty({ a: 1 }, 'hidden', {
      value: 'old', enumerable: false,
    })
    const next = Object.defineProperty({ a: 1 }, 'hidden', {
      value: 'new', enumerable: false,
    })
    expect(computeDeepDiff(prev as any, next as any)).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 9. Very wide objects (100+ keys)
// ═══════════════════════════════════════════════════════════════════════════

describe('computeDeepDiff — wide objects', () => {
  it('handles 200-key flat object with 1 change', () => {
    const prev: Record<string, number> = {}
    const next: Record<string, number> = {}
    for (let i = 0; i < 200; i++) {
      prev[`k${i}`] = i
      next[`k${i}`] = i
    }
    next['k99'] = 999
    const diff = computeDeepDiff(prev, next)
    expect(diff).toEqual({ k99: 999 })
  })

  it('handles 200-key nested object with scattered changes', () => {
    const prev: Record<string, Record<string, number>> = { data: {} }
    const next: Record<string, Record<string, number>> = { data: {} }
    for (let i = 0; i < 200; i++) {
      prev.data[`sensor${i}`] = i
      next.data[`sensor${i}`] = i
    }
    next.data['sensor50'] = 500
    next.data['sensor150'] = 1500
    const diff = computeDeepDiff(prev, next)
    expect(diff).toEqual({ data: { sensor50: 500, sensor150: 1500 } })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 10. Very deep nesting
// ═══════════════════════════════════════════════════════════════════════════

describe('computeDeepDiff — deep nesting', () => {
  function makeDeep(depth: number, leafValue: unknown): Record<string, unknown> {
    if (depth === 0) return { leaf: leafValue }
    return { child: makeDeep(depth - 1, leafValue) }
  }

  it('maxDepth=3: change at depth 5 → falls back to reference comparison', () => {
    const prev = makeDeep(5, 'old')
    const next = makeDeep(5, 'new')
    const diff = computeDeepDiff(prev, next, 0, 3)
    // At depth 4 (> maxDepth=3), reference is different → whole subtree emitted
    expect(diff).not.toBeNull()
    // The leaf change is captured (possibly as full subtree replacement)
    expect(JSON.stringify(diff)).toContain('new')
  })

  it('maxDepth=10: change at depth 5 → granular diff', () => {
    const prev = makeDeep(5, 'old')
    const next = makeDeep(5, 'new')
    const diff = computeDeepDiff(prev, next, 0, 10)
    expect(diff).not.toBeNull()
    // With enough depth, only the leaf is in the diff
    const flat = JSON.stringify(diff)
    expect(flat).toContain('new')
    expect(flat).not.toContain('old')
  })

  it('maxDepth=0: always reference comparison', () => {
    const prev = { a: { b: 1 } }
    const next = { a: { b: 2 } }
    const diff = computeDeepDiff(prev, next, 0, 0)
    // At depth 0, the function still iterates keys but at depth 1 falls back
    expect(diff).toEqual({ a: { b: 2 } })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 11. Circular references
// ═══════════════════════════════════════════════════════════════════════════

describe('computeDeepDiff — circular references', () => {
  it('handles self-referencing object without infinite loop', () => {
    const prev: any = { a: 1 }
    prev.self = prev
    const next: any = { a: 2 }
    next.self = next
    // Should not throw or hang
    const diff = computeDeepDiff(prev, next)
    expect(diff).not.toBeNull()
    expect(diff!.a).toBe(2)
  })

  it('handles mutually referencing objects', () => {
    const prevA: any = { name: 'A' }
    const prevB: any = { name: 'B', ref: prevA }
    prevA.ref = prevB
    const nextA: any = { name: 'A-changed' }
    const nextB: any = { name: 'B', ref: nextA }
    nextA.ref = nextB
    const prev = { root: prevA }
    const next = { root: nextA }
    const diff = computeDeepDiff(prev, next)
    expect(diff).not.toBeNull()
  })
})

describe('deepAssign — circular references', () => {
  it('handles circular source without infinite loop', () => {
    const target = { a: 1 } as any
    const source: any = { a: 2, b: 3 }
    source.self = source
    deepAssign(target, source)
    expect(target.a).toBe(2)
    expect(target.b).toBe(3)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 12. deepAssign — advanced merge scenarios
// ═══════════════════════════════════════════════════════════════════════════

describe('deepAssign — advanced merges', () => {
  it('deep merge 3 levels', () => {
    const target = { a: { b: { c: 1, d: 2 }, e: 3 }, f: 4 }
    deepAssign(target, { a: { b: { c: 10 } } })
    expect(target).toEqual({ a: { b: { c: 10, d: 2 }, e: 3 }, f: 4 })
  })

  it('replaces array (not merged)', () => {
    const target = { items: [1, 2, 3] }
    deepAssign(target, { items: [4, 5] })
    expect(target.items).toEqual([4, 5])
  })

  it('replaces primitive with object', () => {
    const target = { x: 42 as any }
    deepAssign(target, { x: { value: 42, unit: 'px' } })
    expect(target.x).toEqual({ value: 42, unit: 'px' })
  })

  it('replaces object with primitive', () => {
    const target = { x: { value: 42 } as any }
    deepAssign(target, { x: 'collapsed' })
    expect(target.x).toBe('collapsed')
  })

  it('structuredClone isolation — source mutation after assign', () => {
    const source = { nested: { a: 1, b: 2 } }
    const target = {} as any
    deepAssign(target, source)
    // Mutate source after assign
    source.nested.a = 999
    // Target should be isolated
    expect(target.nested.a).toBe(1)
  })

  it('nested null deletes at depth 2+', () => {
    const target = { level1: { level2: { a: 1, b: 2, c: 3 } } }
    deepAssign(target, { level1: { level2: { b: null } } })
    expect(target.level1.level2).toEqual({ a: 1, c: 3 })
    expect('b' in target.level1.level2).toBe(false)
  })

  it('multiple keys updated at once', () => {
    const target = { a: 1, b: 2, c: 3, d: 4 }
    deepAssign(target, { a: 10, c: 30 })
    expect(target).toEqual({ a: 10, b: 2, c: 30, d: 4 })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 13. Round-trip idempotency
// ═══════════════════════════════════════════════════════════════════════════

describe('round-trip: diff → assign → diff === null', () => {
  it('flat object', () => {
    const state = { a: 1, b: 'hello', c: true }
    const update = { a: 2, b: 'hello', c: false }
    const diff = computeDeepDiff(state, update)!
    expect(diff).not.toBeNull()

    const applied = clone(state)
    deepAssign(applied, diff)
    // After applying, a second diff should be null
    const diff2 = computeDeepDiff(applied, update)
    expect(diff2).toBeNull()
  })

  it('nested object with additions', () => {
    const state = { config: { theme: 'light' } }
    const update = { config: { theme: 'dark', fontSize: 14 } }
    const diff = computeDeepDiff(state, update)!
    const applied = clone(state)
    deepAssign(applied, diff)
    expect(computeDeepDiff(applied, update)).toBeNull()
  })

  it('nested object with key removal', () => {
    const state = { players: { A: { hp: 100 }, B: { hp: 50 } } }
    const update = { players: { A: { hp: 80 } } }
    const diff = computeDeepDiff(state, update)!
    const applied = clone(state)
    deepAssign(applied, diff)
    // B was removed, A.hp changed
    expect(applied.players).toEqual({ A: { hp: 80 } })
    expect('B' in applied.players).toBe(false)
    expect(computeDeepDiff(applied, update)).toBeNull()
  })

  it('multiple sequential diffs converge', () => {
    let state: Record<string, unknown> = { x: 0, y: 0, z: 0 }

    for (let i = 1; i <= 5; i++) {
      const update = { x: i, y: i * 2, z: i * 3 }
      const diff = computeDeepDiff(state, update)!
      deepAssign(state, diff)
      expect(computeDeepDiff(state, update)).toBeNull()
    }

    expect(state).toEqual({ x: 5, y: 10, z: 15 })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 14. Real-world domain simulations
// ═══════════════════════════════════════════════════════════════════════════

describe('real-world: IoT sensor dashboard', () => {
  function makeIoTState() {
    return {
      sensors: {
        temp_001: { value: 22.5, unit: 'C', status: 'online', lastPing: 1000 },
        temp_002: { value: 23.1, unit: 'C', status: 'online', lastPing: 1000 },
        humid_001: { value: 65, unit: '%', status: 'online', lastPing: 1000 },
      },
      alerts: [] as string[],
      dashboard: { refreshRate: 5000, layout: 'grid' },
    }
  }

  it('single sensor update → minimal diff', () => {
    const state = makeIoTState()
    // Build update reusing same nested refs for unchanged sensors
    const update = {
      ...state,
      sensors: {
        ...state.sensors,
        temp_001: { ...state.sensors.temp_001, value: 24.0, lastPing: 2000 },
      },
    }

    const diff = computeDeepDiff(state, update)
    expect(diff).toEqual({
      sensors: { temp_001: { value: 24.0, lastPing: 2000 } },
    })
  })

  it('sensor goes offline → status change only', () => {
    const state = makeIoTState()
    const update = {
      ...state,
      sensors: {
        ...state.sensors,
        humid_001: { ...state.sensors.humid_001, status: 'offline' },
      },
    }

    const diff = computeDeepDiff(state, update)
    expect(diff).toEqual({
      sensors: { humid_001: { status: 'offline' } },
    })
  })

  it('sensor removed (device disconnected)', () => {
    const state = makeIoTState()
    const { temp_002, ...remainingSensors } = state.sensors
    const update = {
      ...state,
      sensors: remainingSensors,
    }

    const diff = computeDeepDiff(state, update)
    expect(diff).toEqual({
      sensors: { temp_002: null },
    })
  })

  it('new sensor added', () => {
    const state = makeIoTState()
    const update = {
      ...state,
      sensors: {
        ...state.sensors,
        pressure_001: { value: 1013, unit: 'hPa', status: 'online', lastPing: 3000 },
      },
    }

    const diff = computeDeepDiff(state, update)
    expect(diff).toEqual({
      sensors: { pressure_001: { value: 1013, unit: 'hPa', status: 'online', lastPing: 3000 } },
    })
  })

  it('full cycle: add sensor, update values, remove sensor', () => {
    let state: any = makeIoTState()

    // Add sensor
    const add = clone(state)
    add.sensors.co2_001 = { value: 400, unit: 'ppm', status: 'online', lastPing: 1000 }
    let diff = computeDeepDiff(state, add)!
    deepAssign(state, diff)
    expect(state.sensors.co2_001).toBeDefined()

    // Update values
    const upd = clone(state)
    upd.sensors.co2_001.value = 450
    upd.sensors.temp_001.value = 25
    diff = computeDeepDiff(state, upd)!
    deepAssign(state, diff)
    expect(state.sensors.co2_001.value).toBe(450)
    expect(state.sensors.temp_001.value).toBe(25)

    // Remove sensor
    const rem = clone(state)
    delete rem.sensors.co2_001
    diff = computeDeepDiff(state, rem)!
    deepAssign(state, diff)
    expect('co2_001' in state.sensors).toBe(false)
  })
})

describe('real-world: chat application', () => {
  function makeChatState() {
    return {
      rooms: {
        general: {
          name: 'General',
          unread: 0,
          typing: {} as Record<string, boolean>,
          lastMessage: null as string | null,
        },
        random: {
          name: 'Random',
          unread: 3,
          typing: {} as Record<string, boolean>,
          lastMessage: 'hello',
        },
      },
      user: { id: 'u1', status: 'online' as string, theme: 'dark' },
    }
  }

  it('typing indicator on/off cycle', () => {
    let state = makeChatState() as any

    // User starts typing
    const t1 = clone(state)
    t1.rooms.general.typing = { alice: true }
    let diff = computeDeepDiff(state, t1)!
    deepAssign(state, diff)
    expect(state.rooms.general.typing.alice).toBe(true)

    // User stops typing
    const t2 = clone(state)
    t2.rooms.general.typing = {}
    diff = computeDeepDiff(state, t2)!
    deepAssign(state, diff)
    expect('alice' in state.rooms.general.typing).toBe(false)
  })

  it('new message increments unread, sets lastMessage', () => {
    const state = makeChatState() as any
    const update = clone(state)
    update.rooms.general.unread = 1
    update.rooms.general.lastMessage = 'Hey there!'

    const diff = computeDeepDiff(state, update)
    expect(diff).toEqual({
      rooms: { general: { unread: 1, lastMessage: 'Hey there!' } },
    })
  })

  it('user goes offline → partial update', () => {
    const state = makeChatState()
    const update = { user: { id: 'u1', status: 'offline', theme: 'dark' } }

    const diff = computeDeepDiff(state, update)
    expect(diff).toEqual({ user: { status: 'offline' } })
  })

  it('room added', () => {
    const state = makeChatState() as any
    const update = clone(state)
    update.rooms.announcements = { name: 'Announcements', unread: 0, typing: {}, lastMessage: null }

    const diff = computeDeepDiff(state, update)
    expect(diff).toEqual({
      rooms: {
        announcements: { name: 'Announcements', unread: 0, typing: {}, lastMessage: null },
      },
    })
  })

  it('room removed', () => {
    const state = makeChatState() as any
    const update = clone(state)
    delete update.rooms.random

    const diff = computeDeepDiff(state, update)
    expect(diff).toEqual({ rooms: { random: null } })
  })
})

describe('real-world: e-commerce cart', () => {
  function makeCartState() {
    return {
      items: {
        sku_001: { name: 'Widget', qty: 2, price: 9.99 },
        sku_002: { name: 'Gadget', qty: 1, price: 24.99 },
      },
      totals: { subtotal: 44.97, tax: 3.60, shipping: 5.00 },
      coupon: null as string | null,
    }
  }

  it('quantity change → minimal diff', () => {
    const state = makeCartState()
    const update = clone(state)
    ;(update.items.sku_001 as any).qty = 3
    update.totals.subtotal = 54.96
    update.totals.tax = 4.40

    const diff = computeDeepDiff(state, update)
    expect(diff).toEqual({
      items: { sku_001: { qty: 3 } },
      totals: { subtotal: 54.96, tax: 4.40 },
    })
  })

  it('item removed from cart', () => {
    const state = makeCartState()
    const update = clone(state)
    delete (update.items as any).sku_002
    update.totals.subtotal = 19.98

    const diff = computeDeepDiff(state, update)
    expect(diff).toEqual({
      items: { sku_002: null },
      totals: { subtotal: 19.98 },
    })
  })

  it('coupon applied (null → string)', () => {
    const state = makeCartState()
    const update = { coupon: 'SAVE10' }

    const diff = computeDeepDiff(state, update)
    expect(diff).toEqual({ coupon: 'SAVE10' })
  })

  it('coupon removed (string → null)', () => {
    const state = { ...makeCartState(), coupon: 'SAVE10' as string | null }
    const update = { coupon: null }

    const diff = computeDeepDiff(state as any, update as any)
    expect(diff).toEqual({ coupon: null })
  })

  it('full cart lifecycle: add, update qty, apply coupon, remove item', () => {
    let state: any = { items: {}, totals: { subtotal: 0, tax: 0, shipping: 0 }, coupon: null }

    // Add item
    const s1 = clone(state)
    s1.items.sku_001 = { name: 'Widget', qty: 1, price: 9.99 }
    s1.totals.subtotal = 9.99
    let diff = computeDeepDiff(state, s1)!
    deepAssign(state, diff)

    // Update qty
    const s2 = clone(state)
    s2.items.sku_001.qty = 3
    s2.totals.subtotal = 29.97
    diff = computeDeepDiff(state, s2)!
    deepAssign(state, diff)
    expect(state.items.sku_001.qty).toBe(3)

    // Apply coupon
    diff = computeDeepDiff(state, { coupon: 'DEAL20' })!
    deepAssign(state, diff)
    expect(state.coupon).toBe('DEAL20')

    // Remove item
    const s3 = clone(state)
    delete s3.items.sku_001
    s3.totals.subtotal = 0
    diff = computeDeepDiff(state, s3)!
    deepAssign(state, diff)
    expect('sku_001' in state.items).toBe(false)
    expect(state.totals.subtotal).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 15. Concurrent multi-entity updates (game tick simulation)
// ═══════════════════════════════════════════════════════════════════════════

describe('concurrent multi-entity updates', () => {
  it('50 entities, random fields changed per tick', () => {
    const state: Record<string, Record<string, unknown>> = { entities: {} }
    for (let i = 0; i < 50; i++) {
      (state.entities as any)[`e${i}`] = { x: 0, y: 0, hp: 100, score: 0 }
    }

    // Simulate 10 ticks
    for (let tick = 0; tick < 10; tick++) {
      const update = clone(state)
      // Change 5 random entities per tick
      for (let j = 0; j < 5; j++) {
        const idx = (tick * 5 + j) % 50
        const entity = (update.entities as any)[`e${idx}`]
        entity.x = tick + j
        entity.y = tick * 2 + j
        entity.score = tick * 10
      }
      const diff = computeDeepDiff(state, update)
      if (diff) {
        deepAssign(state, diff)
      }
      // Verify the state matches update for changed entities
      for (let j = 0; j < 5; j++) {
        const idx = (tick * 5 + j) % 50
        expect((state.entities as any)[`e${idx}`].x).toBe(tick + j)
      }
    }
  })

  it('entities added and removed across ticks', () => {
    let state: any = { entities: { e0: { x: 0 }, e1: { x: 1 } } }

    // Tick 1: remove e0, add e2
    const t1 = { entities: { e1: { x: 1 }, e2: { x: 2 } } }
    let diff = computeDeepDiff(state, t1)!
    deepAssign(state, diff)
    expect('e0' in state.entities).toBe(false)
    expect(state.entities.e2.x).toBe(2)

    // Tick 2: remove e1, update e2
    const t2 = { entities: { e2: { x: 20 } } }
    diff = computeDeepDiff(state, t2)!
    deepAssign(state, diff)
    expect('e1' in state.entities).toBe(false)
    expect(state.entities.e2.x).toBe(20)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 16. Boolean & string edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe('computeDeepDiff — boolean & string edge cases', () => {
  it('false → true', () => {
    expect(computeDeepDiff({ flag: false }, { flag: true })).toEqual({ flag: true })
  })

  it('true → false', () => {
    expect(computeDeepDiff({ flag: true }, { flag: false })).toEqual({ flag: false })
  })

  it('empty string → non-empty', () => {
    expect(computeDeepDiff({ name: '' }, { name: 'Alice' })).toEqual({ name: 'Alice' })
  })

  it('non-empty → empty string', () => {
    expect(computeDeepDiff({ name: 'Alice' }, { name: '' })).toEqual({ name: '' })
  })

  it('0 → false → not detected (=== is true in JS... wait, no)', () => {
    // 0 === false is actually false in JS
    const diff = computeDeepDiff({ val: 0 as any }, { val: false as any })
    expect(diff).toEqual({ val: false })
  })

  it('"" → 0 → detected', () => {
    const diff = computeDeepDiff({ val: '' as any }, { val: 0 as any })
    expect(diff).toEqual({ val: 0 })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 17. Large nested diff + deepAssign stress
// ═══════════════════════════════════════════════════════════════════════════

describe('stress: 100-player game server', () => {
  // ── Helpers ──────────────────────────────────────────────────────────

  const ABILITIES = ['fireball', 'heal', 'shield', 'dash', 'teleport'] as const
  const ITEM_POOL = [
    { id: 'sword', name: 'Iron Sword', dmg: 10 },
    { id: 'shield', name: 'Oak Shield', def: 5 },
    { id: 'potion', name: 'HP Potion', heal: 50 },
    { id: 'bow', name: 'Long Bow', dmg: 8, range: 15 },
    { id: 'staff', name: 'Fire Staff', dmg: 12, mana: 20 },
    { id: 'ring', name: 'Speed Ring', speed: 1.5 },
    { id: 'helmet', name: 'Steel Helmet', def: 3 },
    { id: 'boots', name: 'Quick Boots', speed: 1.2 },
  ] as const

  function makePlayer(id: number) {
    return {
      id: `p${id}`,
      nickname: `Player_${id}`,
      team: id % 2 === 0 ? 'red' : 'blue',
      position: { x: id * 2, y: 0.5, z: id === 0 ? 0 : -id },
      rotation: { yaw: 0, pitch: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      speed: 1.0,
      stats: {
        hp: 100,
        maxHp: 100,
        mp: 50,
        maxMp: 50,
        level: 1,
        xp: 0,
        kills: 0,
        deaths: 0,
        assists: 0,
      },
      status: {
        alive: true,
        stunned: false,
        poisoned: false,
        shielded: false,
        invisible: false,
      },
      equipment: {
        weapon: { ...ITEM_POOL[0] },
        armor: { ...ITEM_POOL[1] },
        accessory: null as (typeof ITEM_POOL)[number] | null,
      },
      cooldowns: {
        fireball: 0,
        heal: 0,
        shield: 0,
        dash: 0,
        teleport: 0,
      },
      buffs: {} as Record<string, { duration: number; power: number }>,
      score: 0,
      ready: true,
      lastAction: 0,
    }
  }

  type Player = ReturnType<typeof makePlayer>
  type GameState = {
    players: Record<string, Player>
    world: {
      time: number
      weather: string
      events: Record<string, { type: string; x: number; z: number; radius: number }>
    }
    match: {
      round: number
      phase: string
      redScore: number
      blueScore: number
      timer: number
    }
  }

  function makeGameState(playerCount: number): GameState {
    const players: Record<string, Player> = {}
    for (let i = 0; i < playerCount; i++) {
      players[`p${i}`] = makePlayer(i)
    }
    return {
      players,
      world: {
        time: 0,
        weather: 'clear',
        events: {},
      },
      match: {
        round: 1,
        phase: 'playing',
        redScore: 0,
        blueScore: 0,
        timer: 300,
      },
    }
  }

  /** Build a partial update that reuses unchanged refs */
  function buildUpdate(
    state: GameState,
    changes: Record<string, Partial<Player>>,
    worldChanges?: Partial<GameState['world']>,
    matchChanges?: Partial<GameState['match']>,
  ): GameState {
    const updatedPlayers: Record<string, Player> = {}
    for (const key of Object.keys(state.players)) {
      if (key in changes) {
        updatedPlayers[key] = { ...state.players[key], ...changes[key] } as Player
      } else {
        updatedPlayers[key] = state.players[key] // same ref
      }
    }
    // Add new players from changes
    for (const key of Object.keys(changes)) {
      if (!(key in state.players)) {
        updatedPlayers[key] = changes[key] as Player
      }
    }
    return {
      players: updatedPlayers,
      world: worldChanges ? { ...state.world, ...worldChanges } : state.world,
      match: matchChanges ? { ...state.match, ...matchChanges } : state.match,
    }
  }

  // ── Tests ──────────────────────────────────────────────────────────────

  it('single player moves — minimal diff', () => {
    const state = makeGameState(100)
    const update = buildUpdate(state, {
      p42: { position: { x: 10, y: 5, z: -3 } },
    })

    const diff = computeDeepDiff(state, update)!
    expect(diff).toEqual({
      players: { p42: { position: { x: 10, y: 5, z: -3 } } },
    })

    deepAssign(state, diff)
    expect(state.players.p42.position).toEqual({ x: 10, y: 5, z: -3 })
    expect(state.players.p0.position).toEqual({ x: 0, y: 0.5, z: 0 })
    expect(state.players.p99.position).toEqual({ x: 198, y: 0.5, z: -99 })
  })

  it('30 players move simultaneously in one tick', () => {
    const state = makeGameState(100)
    const changes: Record<string, Partial<Player>> = {}
    for (let i = 0; i < 30; i++) {
      changes[`p${i}`] = {
        position: { x: i * 10, y: 0.5 + i * 0.1, z: i * -5 },
        rotation: { yaw: i * 12, pitch: 0 },
        velocity: { x: 1, y: 0, z: -0.5 },
        speed: 1.0 + i * 0.01,
      }
    }
    const update = buildUpdate(state, changes)

    const diff = computeDeepDiff(state, update)!
    expect(diff).not.toBeNull()

    // Verify diff only contains the 30 changed players
    const diffKeys = Object.keys(diff.players as any)
    expect(diffKeys.length).toBe(30)
    for (let i = 0; i < 30; i++) {
      expect(diffKeys).toContain(`p${i}`)
    }
    // Unchanged players should NOT be in the diff
    expect(diffKeys).not.toContain('p30')
    expect(diffKeys).not.toContain('p99')

    // Apply and verify
    deepAssign(state, diff)
    expect(state.players.p0.position).toEqual({ x: 0, y: 0.5, z: 0 })
    expect(state.players.p15.position).toEqual({ x: 150, y: 2, z: -75 })
    expect(state.players.p29.speed).toBeCloseTo(1.29)
    // Unchanged player
    expect(state.players.p50.position).toEqual({ x: 100, y: 0.5, z: -50 })
  })

  it('all 100 players change position + velocity in a single tick', () => {
    const state = makeGameState(100)
    const changes: Record<string, Partial<Player>> = {}
    for (let i = 0; i < 100; i++) {
      changes[`p${i}`] = {
        position: { x: i + 100, y: 1.0, z: i - 50 },
        velocity: { x: Math.sin(i), y: 0, z: Math.cos(i) },
      }
    }
    const update = buildUpdate(state, changes)

    const diff = computeDeepDiff(state, update)!
    const changedPlayers = Object.keys(diff.players as any)
    expect(changedPlayers.length).toBe(100)

    deepAssign(state, diff)
    for (let i = 0; i < 100; i++) {
      expect(state.players[`p${i}`].position.x).toBe(i + 100)
    }
    // Stats should be untouched
    expect(state.players.p0.stats.hp).toBe(100)
    expect(state.players.p99.stats.level).toBe(1)
  })

  it('50 players take damage, 10 die, 5 respawn — multi-field updates', () => {
    const state = makeGameState(100)
    const changes: Record<string, Partial<Player>> = {}

    // 50 players take damage
    for (let i = 0; i < 50; i++) {
      const newHp = Math.max(0, 100 - (i + 1) * 5)
      changes[`p${i}`] = {
        stats: { ...state.players[`p${i}`].stats, hp: newHp },
      }
    }
    // 10 of those die (hp would be 0)
    for (let i = 40; i < 50; i++) {
      changes[`p${i}`] = {
        ...changes[`p${i}`],
        stats: { ...state.players[`p${i}`].stats, hp: 0, deaths: 1 },
        status: { ...state.players[`p${i}`].status, alive: false },
      }
    }
    // 5 respawns (previously dead players from a "past round" — simulate by setting)
    for (let i = 90; i < 95; i++) {
      changes[`p${i}`] = {
        stats: { ...state.players[`p${i}`].stats, hp: 100 },
        status: { ...state.players[`p${i}`].status, alive: true },
        position: { x: 0, y: 0.5, z: 0 },
      }
    }

    const update = buildUpdate(state, changes)
    const diff = computeDeepDiff(state, update)!
    const diffPlayerKeys = Object.keys(diff.players as any)
    expect(diffPlayerKeys.length).toBe(55) // 50 damaged + 5 respawned

    deepAssign(state, diff)

    // Verify damage
    expect(state.players.p0.stats.hp).toBe(95)
    expect(state.players.p19.stats.hp).toBe(0)
    expect(state.players.p45.status.alive).toBe(false)
    expect(state.players.p45.stats.deaths).toBe(1)

    // Verify respawns
    expect(state.players.p92.position).toEqual({ x: 0, y: 0.5, z: 0 })
    expect(state.players.p92.stats.hp).toBe(100)
    expect(state.players.p92.status.alive).toBe(true)

    // Verify untouched
    expect(state.players.p70.stats.hp).toBe(100)
    expect(state.players.p70.status.alive).toBe(true)
  })

  it('equipment swap + buff apply on 40 players', () => {
    const state = makeGameState(100)
    const changes: Record<string, Partial<Player>> = {}

    for (let i = 0; i < 40; i++) {
      const newWeapon = ITEM_POOL[(i + 2) % ITEM_POOL.length]
      const accessory = ITEM_POOL[(i + 5) % ITEM_POOL.length]
      changes[`p${i}`] = {
        equipment: {
          weapon: newWeapon as any,
          armor: state.players[`p${i}`].equipment.armor,
          accessory: accessory as any,
        },
        buffs: {
          speedBoost: { duration: 10, power: 1.5 },
          ...(i % 3 === 0 ? { damageUp: { duration: 5, power: 2.0 } } : {}),
        },
      }
    }

    const update = buildUpdate(state, changes)
    const diff = computeDeepDiff(state, update)!

    expect(Object.keys(diff.players as any).length).toBe(40)

    deepAssign(state, diff)

    // Equipment lives at depth 2 → weapon at depth 3 (within maxDepth=3).
    // computeDeepDiff recurses into weapon at depth 3, detecting key
    // removal at depth>0: old weapon's 'dmg' absent in new → emitted as null.
    // deepAssign at nested depth deletes null keys. So weapon ends up as
    // a clean merge with only the new weapon's keys.
    const p0Weapon = state.players.p0.equipment.weapon as any
    expect(p0Weapon.id).toBe(ITEM_POOL[2].id)
    expect(p0Weapon.name).toBe(ITEM_POOL[2].name)
    // heal comes from the new weapon (ITEM_POOL[2])
    expect(p0Weapon.heal).toBe((ITEM_POOL[2] as any).heal)
    // dmg was in old weapon but NOT in new → removed via null sentinel
    expect(p0Weapon.dmg).toBeUndefined()
    expect(state.players.p0.equipment.accessory).not.toBeNull()
    expect(state.players.p0.equipment.accessory!.id).toBe(ITEM_POOL[5].id)
    // Armor unchanged
    expect(state.players.p0.equipment.armor.id).toBe(ITEM_POOL[1].id)
    // Verify buffs
    expect(state.players.p0.buffs.speedBoost).toEqual({ duration: 10, power: 1.5 })
    expect(state.players.p0.buffs.damageUp).toEqual({ duration: 5, power: 2.0 })
    expect(state.players.p1.buffs.damageUp).toBeUndefined()

    // Untouched players
    expect(state.players.p60.equipment.weapon).toEqual(ITEM_POOL[0])
    expect(Object.keys(state.players.p60.buffs).length).toBe(0)
  })

  it('10 players disconnect (removed) + 5 new players join in same tick', () => {
    const state = makeGameState(100)

    // Build update: remove p90-p99, add p100-p104
    const updatedPlayers: Record<string, Player> = {}
    for (let i = 0; i < 90; i++) {
      updatedPlayers[`p${i}`] = state.players[`p${i}`]
    }
    for (let i = 100; i < 105; i++) {
      updatedPlayers[`p${i}`] = makePlayer(i)
    }
    const update: GameState = {
      players: updatedPlayers,
      world: state.world,
      match: state.match,
    }

    const diff = computeDeepDiff(state, update)!
    const diffKeys = Object.keys(diff.players as any)

    // 10 removed (null sentinel) + 5 added
    expect(diffKeys.length).toBe(15)
    for (let i = 90; i < 100; i++) {
      expect((diff.players as any)[`p${i}`]).toBeNull()
    }
    for (let i = 100; i < 105; i++) {
      expect((diff.players as any)[`p${i}`]).toBeDefined()
      expect((diff.players as any)[`p${i}`]).not.toBeNull()
    }

    deepAssign(state, diff)

    // Verify removals
    for (let i = 90; i < 100; i++) {
      expect(`p${i}` in state.players).toBe(false)
    }
    // Verify additions
    for (let i = 100; i < 105; i++) {
      expect(state.players[`p${i}`].id).toBe(`p${i}`)
    }
    // Verify untouched
    expect(state.players.p0.id).toBe('p0')
    expect(state.players.p89.id).toBe('p89')
    expect(Object.keys(state.players).length).toBe(95)
  })

  it('world event spawn + weather change + match timer — non-player state', () => {
    const state = makeGameState(100)
    const update = buildUpdate(
      state,
      {}, // no player changes
      {
        time: 120,
        weather: 'storm',
        events: {
          airdrop_1: { type: 'airdrop', x: 50, z: -20, radius: 10 },
          zone_shrink: { type: 'zone', x: 0, z: 0, radius: 80 },
        },
      },
      {
        timer: 240,
        phase: 'mid-game',
      },
    )

    const diff = computeDeepDiff(state, update)!
    expect(diff).not.toHaveProperty('players')
    expect((diff.world as any).time).toBe(120)
    expect((diff.world as any).weather).toBe('storm')
    expect((diff.world as any).events.airdrop_1).toBeDefined()
    expect((diff.match as any).timer).toBe(240)
    expect((diff.match as any).phase).toBe('mid-game')

    deepAssign(state, diff)
    expect(state.world.weather).toBe('storm')
    expect(state.world.events.airdrop_1.radius).toBe(10)
    expect(state.match.phase).toBe('mid-game')
    // Players untouched
    expect(state.players.p0.stats.hp).toBe(100)
  })

  it('cooldown tick — 80 players have at least 1 cooldown decremented', () => {
    const state = makeGameState(100)
    // Set initial cooldowns for 80 players
    for (let i = 0; i < 80; i++) {
      state.players[`p${i}`].cooldowns = {
        fireball: i % 5 === 0 ? 3 : 0,
        heal: i % 3 === 0 ? 5 : 0,
        shield: i % 7 === 0 ? 2 : 0,
        dash: i % 2 === 0 ? 1 : 0,
        teleport: 0,
      }
    }

    // Tick: decrement all non-zero cooldowns by 1
    const changes: Record<string, Partial<Player>> = {}
    let expectedChanges = 0
    for (let i = 0; i < 80; i++) {
      const cd = state.players[`p${i}`].cooldowns
      const newCd = { ...cd }
      let changed = false
      for (const key of Object.keys(cd) as (keyof typeof cd)[]) {
        if (cd[key] > 0) {
          newCd[key] = cd[key] - 1
          changed = true
        }
      }
      if (changed) {
        changes[`p${i}`] = { cooldowns: newCd }
        expectedChanges++
      }
    }

    const update = buildUpdate(state, changes)
    const diff = computeDeepDiff(state, update)!

    expect(Object.keys(diff.players as any).length).toBe(expectedChanges)

    deepAssign(state, diff)

    // Verify a known cooldown
    expect(state.players.p0.cooldowns.fireball).toBe(2) // was 3
    expect(state.players.p0.cooldowns.heal).toBe(4) // was 5
    expect(state.players.p0.cooldowns.dash).toBe(0) // was 1
    // p80+ untouched
    expect(state.players.p85.cooldowns.fireball).toBe(0)
  })

  it('60-frame game loop — position + rotation every frame, stats every 10th', () => {
    const state = makeGameState(100)
    let totalDiffs = 0

    for (let frame = 0; frame < 60; frame++) {
      const changes: Record<string, Partial<Player>> = {}

      // All 100 players move every frame
      for (let i = 0; i < 100; i++) {
        const p = state.players[`p${i}`]
        changes[`p${i}`] = {
          position: {
            x: p.position.x + Math.sin(frame + i) * 0.5,
            y: 0.5,
            z: p.position.z + Math.cos(frame + i) * 0.5,
          },
          rotation: {
            yaw: (frame * 6 + i) % 360,
            pitch: Math.sin(frame * 0.1) * 10,
          },
          lastAction: frame,
        }

        // Stats update every 10th frame
        if (frame % 10 === 0 && frame > 0) {
          changes[`p${i}`].stats = {
            ...p.stats,
            xp: p.stats.xp + 10,
          }
          changes[`p${i}`].score = p.score + 5
        }
      }

      const update = buildUpdate(state, changes)
      const diff = computeDeepDiff(state, update)
      if (diff) {
        totalDiffs++
        deepAssign(state, diff)
      }
    }

    // Every frame should produce a diff (all players move)
    expect(totalDiffs).toBe(60)

    // Verify final state
    expect(state.players.p0.lastAction).toBe(59)
    // XP: 10 per update at frames 10, 20, 30, 40, 50 = 50
    expect(state.players.p0.stats.xp).toBe(50)
    expect(state.players.p0.score).toBe(25) // 5 * 5 updates

    // Position should have drifted from initial
    expect(state.players.p0.position.x).not.toBe(0)
    expect(state.players.p50.position.z).not.toBe(-50)
  })

  it('massive battle: 100 players, damage + kills + status effects + respawn cycle', () => {
    const state = makeGameState(100)
    const deadPlayers = new Set<string>()
    let redKills = 0
    let blueKills = 0

    // Simulate 20 combat ticks
    for (let tick = 0; tick < 20; tick++) {
      const changes: Record<string, Partial<Player>> = {}

      for (let i = 0; i < 100; i++) {
        const pid = `p${i}`
        const p = state.players[pid]

        // Skip dead players (except respawn tick)
        if (deadPlayers.has(pid)) {
          // Respawn after 5 ticks dead
          if (tick % 5 === 0) {
            deadPlayers.delete(pid)
            changes[pid] = {
              stats: { ...p.stats, hp: p.stats.maxHp },
              status: { ...p.status, alive: true, stunned: false, poisoned: false },
              position: { x: p.team === 'red' ? -50 : 50, y: 0.5, z: 0 },
            }
          }
          continue
        }

        // Movement
        const moveChange: Partial<Player> = {
          position: {
            x: p.position.x + (Math.random() - 0.5) * 4,
            y: 0.5,
            z: p.position.z + (Math.random() - 0.5) * 4,
          },
        }

        // Take damage from "enemy" every 2nd tick
        if (tick % 2 === 0) {
          const dmg = 15 + (tick % 7) * 3
          const newHp = Math.max(0, p.stats.hp - dmg)
          moveChange.stats = { ...p.stats, hp: newHp }

          // Apply status effect
          if (tick % 4 === 0) {
            moveChange.status = { ...p.status, poisoned: true }
          }

          // Death
          if (newHp === 0) {
            deadPlayers.add(pid)
            moveChange.status = { ...(moveChange.status || p.status), alive: false }
            moveChange.stats = { ...(moveChange.stats || p.stats), hp: 0, deaths: p.stats.deaths + 1 }
            if (p.team === 'red') blueKills++
            else redKills++
          }
        }

        // Buff tick
        if (Object.keys(p.buffs).length > 0) {
          const newBuffs: Record<string, { duration: number; power: number }> = {}
          for (const [bk, bv] of Object.entries(p.buffs)) {
            if (bv.duration > 1) {
              newBuffs[bk] = { ...bv, duration: bv.duration - 1 }
            }
            // else buff expired, don't include
          }
          moveChange.buffs = newBuffs
        }

        changes[pid] = moveChange
      }

      const update = buildUpdate(state, changes)
      const diff = computeDeepDiff(state, update)
      if (diff) {
        deepAssign(state, diff)
      }
    }

    // Verify state consistency
    let aliveCount = 0
    let deadCount = 0
    for (let i = 0; i < 100; i++) {
      const p = state.players[`p${i}`]
      if (p.status.alive) {
        aliveCount++
        expect(p.stats.hp).toBeGreaterThan(0)
      } else {
        deadCount++
        expect(p.stats.hp).toBe(0)
      }
      // Deaths should be non-negative
      expect(p.stats.deaths).toBeGreaterThanOrEqual(0)
      // Unchanged fields should persist
      expect(p.id).toBe(`p${i}`)
      expect(p.nickname).toBe(`Player_${i}`)
      expect(p.team).toBe(i % 2 === 0 ? 'red' : 'blue')
      expect(p.stats.maxHp).toBe(100)
      expect(p.stats.maxMp).toBe(50)
      expect(p.stats.level).toBe(1)
    }

    // Some players should have died
    expect(deadCount + aliveCount).toBe(100)
    expect(redKills + blueKills).toBeGreaterThan(0)
  })

  it('round-trip stability: 30 ticks of diff→assign→re-diff produces null', () => {
    const state = makeGameState(100)

    for (let tick = 0; tick < 30; tick++) {
      const changes: Record<string, Partial<Player>> = {}
      // Move 20 players per tick
      const startIdx = (tick * 20) % 100
      for (let j = 0; j < 20; j++) {
        const idx = (startIdx + j) % 100
        changes[`p${idx}`] = {
          position: { x: tick * 10 + j, y: 0.5, z: -tick * 5 + j },
          rotation: { yaw: tick * 15, pitch: j },
          speed: 1.0 + tick * 0.05,
          lastAction: tick,
        }
      }

      const update = buildUpdate(state, changes)
      const diff = computeDeepDiff(state, update)!
      expect(diff).not.toBeNull()

      deepAssign(state, diff)

      // Re-diff with the same update should produce null
      const reDiff = computeDeepDiff(state, update)
      expect(reDiff).toBeNull()
    }
  })

  it('scoreboard update: all 100 players get score/kill/death changes + team totals', () => {
    const state = makeGameState(100)
    const changes: Record<string, Partial<Player>> = {}

    for (let i = 0; i < 100; i++) {
      const p = state.players[`p${i}`]
      changes[`p${i}`] = {
        score: i * 100 + 50,
        stats: {
          ...p.stats,
          kills: Math.floor(i / 3),
          deaths: Math.floor(i / 5),
          assists: Math.floor(i / 7),
          xp: i * 200,
        },
      }
    }

    const update = buildUpdate(state, changes, undefined, {
      redScore: 42,
      blueScore: 38,
      timer: 120,
    })

    const diff = computeDeepDiff(state, update)!

    // All 100 players should be in the diff
    expect(Object.keys(diff.players as any).length).toBe(100)
    // Match data should be in diff
    expect((diff.match as any).redScore).toBe(42)
    expect((diff.match as any).blueScore).toBe(38)
    expect((diff.match as any).timer).toBe(120)

    deepAssign(state, diff)

    // Spot-check
    expect(state.players.p0.score).toBe(50)
    expect(state.players.p99.score).toBe(9950)
    expect(state.players.p33.stats.kills).toBe(11)
    expect(state.players.p50.stats.xp).toBe(10000)
    expect(state.match.redScore).toBe(42)
    expect(state.match.blueScore).toBe(38)
    // Unchanged
    expect(state.match.round).toBe(1)
    expect(state.match.phase).toBe('playing')
  })

  it('status effect cascade: poison ticks + stun + shield on/off across 100 players', () => {
    const state = makeGameState(100)

    // Apply varied initial status effects
    for (let i = 0; i < 100; i++) {
      state.players[`p${i}`].status = {
        alive: true,
        stunned: i % 10 === 0,
        poisoned: i % 3 === 0,
        shielded: i % 5 === 0,
        invisible: i % 15 === 0,
      }
      if (i % 3 === 0) {
        state.players[`p${i}`].buffs = {
          poison: { duration: 5, power: 3 },
        }
      }
      if (i % 5 === 0) {
        state.players[`p${i}`].buffs = {
          ...state.players[`p${i}`].buffs,
          shield: { duration: 3, power: 50 },
        }
      }
    }

    // Tick: decrement buff durations, apply poison damage, remove expired
    const changes: Record<string, Partial<Player>> = {}
    for (let i = 0; i < 100; i++) {
      const p = state.players[`p${i}`]
      const buffs = { ...p.buffs }
      const stats = { ...p.stats }
      const status = { ...p.status }
      let changed = false

      for (const [bk, bv] of Object.entries(buffs)) {
        if (bv.duration <= 1) {
          delete buffs[bk]
          // Remove corresponding status
          if (bk === 'poison') { status.poisoned = false; changed = true }
          if (bk === 'shield') { status.shielded = false; changed = true }
          changed = true
        } else {
          buffs[bk] = { ...bv, duration: bv.duration - 1 }
          changed = true
          // Poison damage
          if (bk === 'poison') {
            stats.hp = Math.max(0, stats.hp - bv.power)
            changed = true
          }
        }
      }

      // Clear stun (1 tick duration)
      if (p.status.stunned) {
        status.stunned = false
        changed = true
      }

      if (changed) {
        changes[`p${i}`] = { buffs, stats, status }
      }
    }

    const update = buildUpdate(state, changes)
    const diff = computeDeepDiff(state, update)!
    expect(diff).not.toBeNull()

    deepAssign(state, diff)

    // All stunned players should now be unstunned
    for (let i = 0; i < 100; i += 10) {
      expect(state.players[`p${i}`].status.stunned).toBe(false)
    }
    // Poisoned players took damage
    expect(state.players.p0.stats.hp).toBe(97) // 100 - 3 (poison power)
    expect(state.players.p3.stats.hp).toBe(97)
    // Non-poisoned players still at 100
    expect(state.players.p1.stats.hp).toBe(100)
  })
})
