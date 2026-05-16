// StateValidator — checksum, conflict detection, merge strategies.
// 100+ untested LoC of client conflict-resolution logic.

import { describe, it, expect } from 'vitest'
import { StateValidator, type HybridState, type StateConflict } from '../state-validator'

describe('StateValidator.generateChecksum', () => {
  it('produces a stable hex string', () => {
    const c = StateValidator.generateChecksum({ a: 1, b: 2 })
    expect(typeof c).toBe('string')
    expect(/^[0-9a-f]+$/.test(c)).toBe(true)
  })

  it('is deterministic across calls with the same input', () => {
    const a = StateValidator.generateChecksum({ x: 'hello', n: 1 })
    const b = StateValidator.generateChecksum({ x: 'hello', n: 1 })
    expect(a).toBe(b)
  })

  it('is order-independent for top-level keys', () => {
    // The implementation sorts top-level keys before stringifying.
    const a = StateValidator.generateChecksum({ a: 1, b: 2, c: 3 })
    const b = StateValidator.generateChecksum({ c: 3, b: 2, a: 1 })
    expect(a).toBe(b)
  })

  it('changes when a value changes', () => {
    const a = StateValidator.generateChecksum({ x: 1 })
    const b = StateValidator.generateChecksum({ x: 2 })
    expect(a).not.toBe(b)
  })

  it('changes when a new key is added', () => {
    const a = StateValidator.generateChecksum({ x: 1 })
    const b = StateValidator.generateChecksum({ x: 1, y: 2 })
    expect(a).not.toBe(b)
  })
})

describe('StateValidator.createValidation', () => {
  it('returns a validation object with all required fields', () => {
    const v = StateValidator.createValidation({ x: 1 }, 'server')
    expect(v.checksum).toBeDefined()
    expect(typeof v.version).toBe('number')
    expect(typeof v.timestamp).toBe('number')
    expect(v.source).toBe('server')
  })

  it('defaults source to client', () => {
    const v = StateValidator.createValidation({ x: 1 })
    expect(v.source).toBe('client')
  })
})

describe('StateValidator.detectConflicts', () => {
  it('returns no conflicts when client and server states are identical', () => {
    const conflicts = StateValidator.detectConflicts({ x: 1, y: 2 }, { x: 1, y: 2 })
    expect(conflicts).toEqual([])
  })

  it('detects a value mismatch', () => {
    const conflicts = StateValidator.detectConflicts({ x: 1 }, { x: 2 })
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.property).toBe('x')
    expect(conflicts[0]!.clientValue).toBe(1)
    expect(conflicts[0]!.serverValue).toBe(2)
    expect(conflicts[0]!.resolved).toBe(false)
  })

  it('detects keys present only on the server', () => {
    const conflicts = StateValidator.detectConflicts({ x: 1 }, { x: 1, extra: 'y' })
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.property).toBe('extra')
    expect(conflicts[0]!.clientValue).toBeUndefined()
    expect(conflicts[0]!.serverValue).toBe('y')
  })

  it('detects keys present only on the client', () => {
    const conflicts = StateValidator.detectConflicts({ x: 1, ghost: 99 }, { x: 1 })
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.property).toBe('ghost')
  })

  it('excludes lastUpdated and version by default', () => {
    const conflicts = StateValidator.detectConflicts(
      { x: 1, lastUpdated: 100, version: 1 },
      { x: 1, lastUpdated: 200, version: 2 },
    )
    expect(conflicts).toEqual([])
  })

  it('respects custom excludeFields', () => {
    const conflicts = StateValidator.detectConflicts(
      { x: 1, y: 'a' },
      { x: 2, y: 'b' },
      ['y'],
    )
    expect(conflicts.map(c => c.property)).toEqual(['x'])
  })

  it('detects nested object differences (via JSON.stringify comparison)', () => {
    const conflicts = StateValidator.detectConflicts(
      { nested: { a: 1 } },
      { nested: { a: 2 } },
    )
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.property).toBe('nested')
  })

  it('handles null/undefined inputs gracefully', () => {
    expect(() => StateValidator.detectConflicts(null as any, { x: 1 })).not.toThrow()
    expect(() => StateValidator.detectConflicts({ x: 1 }, null as any)).not.toThrow()
  })
})

describe('StateValidator.mergeStates', () => {
  const conflicts: StateConflict[] = [
    { property: 'count', clientValue: 5, serverValue: 10, timestamp: 0, resolved: false },
    { property: 'name', clientValue: 'alice', serverValue: 'bob', timestamp: 0, resolved: false },
  ]

  it('strategy=client keeps the client values', () => {
    const merged = StateValidator.mergeStates({ count: 5, name: 'alice' }, { count: 10, name: 'bob' }, conflicts, 'client')
    expect(merged).toEqual({ count: 5, name: 'alice' })
  })

  it('strategy=server overwrites client with server values', () => {
    const merged = StateValidator.mergeStates({ count: 5, name: 'alice' }, { count: 10, name: 'bob' }, conflicts, 'server')
    expect(merged).toEqual({ count: 10, name: 'bob' })
  })

  it('strategy=smart picks max for numeric, server for non-numeric', () => {
    const merged = StateValidator.mergeStates({ count: 5, name: 'alice' }, { count: 10, name: 'bob' }, conflicts, 'smart')
    expect(merged.count).toBe(10) // max(5,10)
    expect(merged.name).toBe('bob') // non-numeric → server wins
  })

  it('strategy=smart picks max even when client is higher', () => {
    const c = [{ property: 'count', clientValue: 99, serverValue: 50, timestamp: 0, resolved: false }]
    const merged = StateValidator.mergeStates({ count: 99 }, { count: 50 }, c, 'smart')
    expect(merged.count).toBe(99)
  })

  it('strategy=smart uses server value for lastUpdated specifically', () => {
    const c = [{ property: 'lastUpdated', clientValue: 1000, serverValue: 2000, timestamp: 0, resolved: false }]
    const merged: any = StateValidator.mergeStates({ lastUpdated: 1000 }, { lastUpdated: 2000 }, c, 'smart')
    expect(merged.lastUpdated).toBe(2000)
  })

  it('returns a new object (does not mutate inputs)', () => {
    const client = { count: 5 }
    const merged = StateValidator.mergeStates(client, { count: 10 }, [{ property: 'count', clientValue: 5, serverValue: 10, timestamp: 0, resolved: false }], 'server')
    expect(merged).not.toBe(client)
    expect(client.count).toBe(5)
  })
})

describe('StateValidator.validateState', () => {
  it('returns true when the checksum matches the current state', () => {
    const data = { x: 1, y: 2 }
    const state: HybridState<typeof data> = {
      data,
      validation: StateValidator.createValidation(data),
      status: 'synced',
    }
    expect(StateValidator.validateState(state)).toBe(true)
  })

  it('returns false when the data has been tampered with after checksum', () => {
    const data = { x: 1, y: 2 }
    const state: HybridState<typeof data> = {
      data,
      validation: StateValidator.createValidation(data),
      status: 'synced',
    }
    // Mutate AFTER checksum captured
    state.data.x = 99
    expect(StateValidator.validateState(state)).toBe(false)
  })
})

describe('StateValidator.updateValidation', () => {
  it('returns a new HybridState with a fresh validation and synced status', () => {
    const data = { x: 1 }
    const orig: HybridState<typeof data> = {
      data,
      validation: { checksum: 'stale', version: 0, timestamp: 0, source: 'mount' },
      status: 'pending',
    }
    const updated = StateValidator.updateValidation(orig, 'server')
    expect(updated.status).toBe('synced')
    expect(updated.validation.source).toBe('server')
    expect(updated.validation.checksum).not.toBe('stale')
    expect(updated.data).toBe(data) // same data reference
  })
})
