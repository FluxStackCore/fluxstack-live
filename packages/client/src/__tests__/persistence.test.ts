// persistence.ts — localStorage round-trip, TTL expiry, no-op when disabled,
// quota-exceeded resilience. Zero coverage before this file.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { persistState, getPersistedState, clearPersistedState } from '../persistence'

// jsdom-free mock — vitest does not bring a DOM by default for this package.
class FakeStorage implements Storage {
  private store = new Map<string, string>()
  get length() { return this.store.size }
  clear() { this.store.clear() }
  getItem(k: string) { return this.store.get(k) ?? null }
  key(i: number) { return Array.from(this.store.keys())[i] ?? null }
  removeItem(k: string) { this.store.delete(k) }
  setItem(k: string, v: string) { this.store.set(k, v) }
  /** test helper */
  _setRaw(k: string, v: string) { this.store.set(k, v) }
}

class ThrowingStorage implements Storage {
  length = 0
  clear() {}
  getItem() { return null }
  key() { return null }
  removeItem() {}
  setItem() { throw new DOMException('QuotaExceededError', 'QuotaExceededError') }
}

let fake: FakeStorage
beforeEach(() => {
  fake = new FakeStorage()
  ;(globalThis as any).localStorage = fake
})
afterEach(() => {
  delete (globalThis as any).localStorage
})

describe('persistState', () => {
  it('writes a JSON blob to localStorage when enabled', () => {
    persistState(true, 'Counter', { sig: 'abc', state: { count: 1 } }, 'lobby', 'user-1')
    const raw = fake.getItem('fluxstack_component_Counter')
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw!)
    expect(parsed.componentName).toBe('Counter')
    expect(parsed.signedState).toEqual({ sig: 'abc', state: { count: 1 } })
    expect(parsed.room).toBe('lobby')
    expect(parsed.userId).toBe('user-1')
    expect(typeof parsed.lastUpdate).toBe('number')
  })

  it('is a no-op when enabled is false', () => {
    persistState(false, 'Counter', { x: 1 })
    expect(fake.getItem('fluxstack_component_Counter')).toBeNull()
  })

  it('does not throw when localStorage throws (quota exceeded)', () => {
    ;(globalThis as any).localStorage = new ThrowingStorage()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => persistState(true, 'Counter', { x: 1 })).not.toThrow()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('omits optional room/userId when not provided', () => {
    persistState(true, 'X', { a: 1 })
    const parsed = JSON.parse(fake.getItem('fluxstack_component_X')!)
    expect(parsed.room).toBeUndefined()
    expect(parsed.userId).toBeUndefined()
  })

  it('overwrites prior state for the same component name', () => {
    persistState(true, 'X', { v: 1 })
    persistState(true, 'X', { v: 2 })
    const parsed = JSON.parse(fake.getItem('fluxstack_component_X')!)
    expect(parsed.signedState.v).toBe(2)
  })
})

describe('getPersistedState', () => {
  it('returns null when not enabled', () => {
    persistState(true, 'X', { v: 1 })
    expect(getPersistedState(false, 'X')).toBeNull()
  })

  it('returns null when nothing is stored', () => {
    expect(getPersistedState(true, 'Ghost')).toBeNull()
  })

  it('round-trips the persisted state', () => {
    persistState(true, 'Counter', { v: 99 }, 'lobby', 'u-1')
    const got = getPersistedState(true, 'Counter')
    expect(got).toBeTruthy()
    expect(got!.componentName).toBe('Counter')
    expect(got!.signedState).toEqual({ v: 99 })
    expect(got!.room).toBe('lobby')
    expect(got!.userId).toBe('u-1')
  })

  it('returns null and removes the key when state is older than 24h', () => {
    const oldTs = Date.now() - (25 * 60 * 60 * 1000)
    fake._setRaw('fluxstack_component_Stale', JSON.stringify({
      componentName: 'Stale', signedState: {}, lastUpdate: oldTs,
    }))
    expect(getPersistedState(true, 'Stale')).toBeNull()
    expect(fake.getItem('fluxstack_component_Stale')).toBeNull()
  })

  it('keeps state that is just under the 24h TTL', () => {
    const recentTs = Date.now() - (23 * 60 * 60 * 1000)
    fake._setRaw('fluxstack_component_Fresh', JSON.stringify({
      componentName: 'Fresh', signedState: { ok: true }, lastUpdate: recentTs,
    }))
    const got = getPersistedState(true, 'Fresh')
    expect(got).toBeTruthy()
    expect(got!.signedState.ok).toBe(true)
  })

  it('returns null when the stored value is corrupt JSON', () => {
    fake._setRaw('fluxstack_component_Bad', '{not json')
    expect(getPersistedState(true, 'Bad')).toBeNull()
  })
})

describe('clearPersistedState', () => {
  it('removes the entry when enabled', () => {
    persistState(true, 'X', { a: 1 })
    clearPersistedState(true, 'X')
    expect(fake.getItem('fluxstack_component_X')).toBeNull()
  })

  it('is a no-op when enabled is false', () => {
    persistState(true, 'X', { a: 1 })
    clearPersistedState(false, 'X')
    expect(fake.getItem('fluxstack_component_X')).not.toBeNull()
  })

  it('does not throw when the key does not exist', () => {
    expect(() => clearPersistedState(true, 'Ghost')).not.toThrow()
  })
})
