import { describe, it, expect, afterEach } from 'vitest'
import { StateSignatureManager } from '../../security/StateSignature'

describe('StateSignatureManager - Nonce system', () => {
  let manager: StateSignatureManager

  afterEach(() => {
    manager?.shutdown()
  })

  it('should reject replay of a used nonce', async () => {
    manager = new StateSignatureManager({
      secret: 'test-secret-32chars-minimum-ok!',
      nonceEnabled: true,
    })

    const signed = await manager.signState('comp-1', { count: 1 }, 1)

    // First validation should succeed
    const result1 = await manager.validateState(signed)
    expect(result1.valid).toBe(true)

    // Same signed state replayed -> reject
    const result2 = await manager.validateState(signed)
    expect(result2.valid).toBe(false)
    expect(result2.error).toContain('Nonce already used')
  })

  it('should remove only expired nonces during cleanup', async () => {
    manager = new StateSignatureManager({
      secret: 'test-secret-32chars-minimum-ok!',
      nonceEnabled: true,
      maxStateAge: 100, // 100ms for testing
    })

    // Sign and validate state (adds nonce to map)
    const signed1 = await manager.signState('comp-1', { count: 1 }, 1)
    await manager.validateState(signed1)

    // Wait for the nonce to expire
    await new Promise(resolve => setTimeout(resolve, 150))

    // Sign a fresh state
    const signed2 = await manager.signState('comp-2', { count: 2 }, 1)
    await manager.validateState(signed2)

    // Run cleanup
    ;(manager as any).cleanupNonces()

    // The expired nonce from signed1 should be cleaned up.
    // The fresh nonce from signed2 should survive.
    const nonceMap = (manager as any).usedNonces as Map<string, number>
    expect(nonceMap.size).toBe(1)
    expect(nonceMap.has(signed2.nonce!)).toBe(true)
  })

  it('should keep non-expired nonces after cleanup', async () => {
    manager = new StateSignatureManager({
      secret: 'test-secret-32chars-minimum-ok!',
      nonceEnabled: true,
      maxStateAge: 60000, // 60 seconds - won't expire during test
    })

    const signed1 = await manager.signState('comp-1', { count: 1 }, 1)
    const signed2 = await manager.signState('comp-2', { count: 2 }, 1)

    await manager.validateState(signed1)
    await manager.validateState(signed2)

    // Run cleanup - nothing should be removed since nonces are fresh
    ;(manager as any).cleanupNonces()

    const nonceMap = (manager as any).usedNonces as Map<string, number>
    expect(nonceMap.size).toBe(2)
  })

  it('should reject new requests when maxNonces is exceeded (backpressure)', async () => {
    manager = new StateSignatureManager({
      secret: 'test-secret-32chars-minimum-ok!',
      nonceEnabled: true,
      maxNonces: 2, // tiny limit for testing
    })

    // Fill up nonce storage
    const s1 = await manager.signState('c1', { a: 1 }, 1)
    const s2 = await manager.signState('c2', { a: 2 }, 1)
    await manager.validateState(s1)
    await manager.validateState(s2)

    // Now nonce storage is at maxNonces (2)
    const s3 = await manager.signState('c3', { a: 3 }, 1)
    const result = await manager.validateState(s3)

    expect(result.valid).toBe(false)
    expect(result.error).toContain('backpressure')
  })
})
