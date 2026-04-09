// BUG: Nonce Map in StateSignatureManager grows without limit.
// An attacker can generate millions of valid nonces causing DoS via memory exhaustion.
// Fix: cap usedNonces at MAX_NONCES (100_000) and evict oldest 10% when exceeded.

import { describe, it, expect, afterEach } from 'vitest'
import { StateSignatureManager } from '../../security/StateSignature'

describe('BUG: StateSignatureManager nonce Map unbounded growth', () => {
  const instances: StateSignatureManager[] = []

  function create(config?: ConstructorParameters<typeof StateSignatureManager>[0]) {
    const m = new StateSignatureManager({ secret: 'test-secret-key', nonceEnabled: true, nonceTTL: 60_000, ...config })
    instances.push(m)
    return m
  }

  afterEach(() => {
    instances.forEach(m => m.shutdown())
    instances.length = 0
  })

  it('should cap usedNonces at MAX_NONCES (100_000)', () => {
    const manager = create()

    // Access the private usedNonces map for testing
    const usedNonces = (manager as any).usedNonces as Map<string, number>

    // Simulate inserting 110_000 nonces directly (bypassing validation)
    const now = Date.now()
    for (let i = 0; i < 110_000; i++) {
      usedNonces.set(`fake-nonce-${i}`, now)
    }

    expect(usedNonces.size).toBe(110_000)

    // Sign + validate a state to trigger the cleanup logic
    const signed = manager.signState('test-comp', { count: 1 }, 1)
    manager.validateState(signed)

    // After cleanup, size should be at or below MAX_NONCES
    const MAX_NONCES = (StateSignatureManager as any).MAX_NONCES ?? 100_000
    expect(usedNonces.size).toBeLessThanOrEqual(MAX_NONCES)
  })

  it('should still reject replayed nonces after cleanup', () => {
    const manager = create()

    // Sign and validate a state (stores the nonce)
    const signed = manager.signState('test-comp', { count: 1 }, 1)
    const result1 = manager.validateState(signed)
    expect(result1.valid).toBe(true)

    // Replay the same signed state — should be rejected
    const result2 = manager.validateState(signed)
    expect(result2.valid).toBe(false)
    expect(result2.error).toBe('Nonce already used')
  })

  it('should evict oldest entries when over limit', () => {
    const manager = create()
    const usedNonces = (manager as any).usedNonces as Map<string, number>

    // Insert 100_001 entries with sequential timestamps
    for (let i = 0; i < 100_001; i++) {
      usedNonces.set(`nonce-${i}`, i) // timestamp = i (oldest first)
    }

    // Trigger cleanup by signing + validating
    const signed = manager.signState('test-comp', { count: 1 }, 1)
    manager.validateState(signed)

    const MAX_NONCES = (StateSignatureManager as any).MAX_NONCES ?? 100_000

    // Map should have been trimmed
    expect(usedNonces.size).toBeLessThanOrEqual(MAX_NONCES)

    // The oldest entries should have been evicted
    // nonce-0 was the oldest and should be gone
    expect(usedNonces.has('nonce-0')).toBe(false)
  })
})
