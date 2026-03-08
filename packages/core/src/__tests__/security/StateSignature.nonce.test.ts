import { describe, it, expect, afterEach } from 'vitest'
import { StateSignatureManager } from '../../security/StateSignature'

describe('StateSignatureManager - Hybrid nonce system', () => {
  let manager: StateSignatureManager

  afterEach(() => {
    manager?.shutdown()
  })

  it('should generate and validate a fresh nonce successfully', () => {
    manager = new StateSignatureManager({
      secret: 'test-secret-32chars-minimum-ok!',
      nonceEnabled: true,
      nonceTTL: 60000,
    })

    const signed = manager.signState('comp-1', { count: 1 }, 1)
    expect(signed.nonce).toBeDefined()
    // Format: timestamp:random:hmac
    expect(signed.nonce!.split(':').length).toBe(3)

    const result = manager.validateState(signed)
    expect(result.valid).toBe(true)
  })

  it('should reject replay of a used nonce', () => {
    manager = new StateSignatureManager({
      secret: 'test-secret-32chars-minimum-ok!',
      nonceEnabled: true,
      nonceTTL: 60000,
    })

    const signed = manager.signState('comp-1', { count: 1 }, 1)

    // First validation should succeed
    const result1 = manager.validateState(signed)
    expect(result1.valid).toBe(true)

    // Same signed state replayed -> reject
    const result2 = manager.validateState(signed)
    expect(result2.valid).toBe(false)
    expect(result2.error).toContain('Nonce already used')
  })

  it('should reject an expired nonce (beyond TTL)', async () => {
    manager = new StateSignatureManager({
      secret: 'test-secret-32chars-minimum-ok!',
      nonceEnabled: true,
      nonceTTL: 50, // 50ms TTL for fast expiry
    })

    const signed = manager.signState('comp-1', { count: 1 }, 1)

    // Wait for nonce to expire
    await new Promise(resolve => setTimeout(resolve, 100))

    const result = manager.validateState(signed)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('Nonce expired')
  })

  it('should reject a forged/tampered nonce HMAC', () => {
    manager = new StateSignatureManager({
      secret: 'test-secret-32chars-minimum-ok!',
      nonceEnabled: true,
    })

    const signed = manager.signState('comp-1', { count: 1 }, 1)

    // Tamper with the HMAC portion of the nonce
    const [ts, rand] = signed.nonce!.split(':')
    signed.nonce = `${ts}:${rand}:deadbeef00000000`

    // Tampering with the nonce also invalidates the state signature
    const result = manager.validateState(signed)
    expect(result.valid).toBe(false)
  })

  it('should reject a malformed nonce (no colon separator)', () => {
    manager = new StateSignatureManager({
      secret: 'test-secret-32chars-minimum-ok!',
      nonceEnabled: true,
    })

    const signed = manager.signState('comp-1', { count: 1 }, 1)
    signed.nonce = 'malformed-nonce-no-colon'

    const result = manager.validateState(signed)
    expect(result.valid).toBe(false)
  })

  it('should reject a nonce with timestamp far in the future', () => {
    manager = new StateSignatureManager({
      secret: 'test-secret-32chars-minimum-ok!',
      nonceEnabled: true,
    })

    const signed = manager.signState('comp-1', { count: 1 }, 1)

    const futureTs = (Date.now() + 60000).toString()
    signed.nonce = `${futureTs}:0000000000000000:0000000000000000`
    const result = manager.validateState(signed)
    expect(result.valid).toBe(false)
  })

  it('should track used nonces in memory for replay detection', () => {
    manager = new StateSignatureManager({
      secret: 'test-secret-32chars-minimum-ok!',
      nonceEnabled: true,
    })

    const usedNonces = (manager as any).usedNonces as Map<string, number>
    expect(usedNonces).toBeInstanceOf(Map)
    expect(usedNonces.size).toBe(0)

    const signed = manager.signState('comp-1', { count: 1 }, 1)
    manager.validateState(signed)

    // After validation, nonce is stored
    expect(usedNonces.size).toBe(1)
    expect(usedNonces.has(signed.nonce!)).toBe(true)
  })

  it('should cleanup expired nonces from replay map', async () => {
    manager = new StateSignatureManager({
      secret: 'test-secret-32chars-minimum-ok!',
      nonceEnabled: true,
      nonceTTL: 60000,
    })

    // Validate a nonce to add it to the map
    const signed1 = manager.signState('comp-1', { count: 1 }, 1)
    manager.validateState(signed1)

    const usedNonces = (manager as any).usedNonces as Map<string, number>
    expect(usedNonces.size).toBe(1)

    // Manually backdate the nonce entry beyond nonceTTL + 10s (60s + 10s = 70s)
    usedNonces.set(signed1.nonce!, Date.now() - 71 * 1000)

    // Add a fresh nonce
    const signed2 = manager.signState('comp-2', { count: 2 }, 1)
    manager.validateState(signed2)
    expect(usedNonces.size).toBe(2)

    // Run cleanup
    ;(manager as any).cleanupNonces()

    // Old nonce removed, fresh one survives
    expect(usedNonces.size).toBe(1)
    expect(usedNonces.has(signed2.nonce!)).toBe(true)
  })

  it('should produce unique nonces for each sign call', () => {
    manager = new StateSignatureManager({
      secret: 'test-secret-32chars-minimum-ok!',
      nonceEnabled: true,
    })

    const signed1 = manager.signState('comp-1', { a: 1 }, 1)
    const signed2 = manager.signState('comp-2', { a: 2 }, 1)

    expect(signed1.nonce).toBeDefined()
    expect(signed2.nonce).toBeDefined()

    // Both should validate (different nonces)
    expect(manager.validateState(signed1).valid).toBe(true)
    expect(manager.validateState(signed2).valid).toBe(true)
  })

  it('should not include nonce when nonceEnabled is false', () => {
    manager = new StateSignatureManager({
      secret: 'test-secret-32chars-minimum-ok!',
      nonceEnabled: false,
    })

    const signed = manager.signState('comp-1', { count: 1 }, 1)
    expect(signed.nonce).toBeUndefined()

    // Without nonces, same state can validate multiple times
    const result1 = manager.validateState(signed)
    expect(result1.valid).toBe(true)
    const result2 = manager.validateState(signed)
    expect(result2.valid).toBe(true)
  })
})
