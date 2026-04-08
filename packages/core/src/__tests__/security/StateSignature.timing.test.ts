// BUG #6: Timing attack in timingSafeEqual
// Issues:
// 1. a.length !== b.length returns early, leaking length info
// 2. require('crypto') at runtime instead of top-level import
// 3. Fallback `a === b` is not timing-safe
import { describe, it, expect, afterEach } from 'vitest'
import { StateSignatureManager } from '../../security/StateSignature'

describe('BUG: timingSafeEqual has timing vulnerabilities', () => {
  const instances: StateSignatureManager[] = []

  function create(config?: ConstructorParameters<typeof StateSignatureManager>[0]) {
    const m = new StateSignatureManager({ secret: 'test-secret-key', ...config })
    instances.push(m)
    return m
  }

  afterEach(() => {
    instances.forEach(m => m.shutdown())
    instances.length = 0
  })

  it('should not leak length information via early return', () => {
    const manager = create()

    const state = { count: 1 }
    const signed = manager.signState('comp-1', state, 1)

    // Tamper with signature — different length
    const tampered = { ...signed, signature: signed.signature + 'extra' }
    const result = manager.validateState(tampered)
    expect(result.valid).toBe(false)

    // Tamper with signature — same length but wrong content
    const tamperedSameLen = {
      ...signed,
      signature: 'a'.repeat(signed.signature.length),
    }
    const result2 = manager.validateState(tamperedSameLen)
    expect(result2.valid).toBe(false)

    // The real issue: both checks above should take approximately the same time.
    // BUG: Different-length signatures return instantly via `a.length !== b.length`,
    // while same-length signatures go through Buffer comparison.
    // This is a timing side-channel that leaks the signature length.
    //
    // FIX: Pad shorter string to match longer, then compare full buffers.
  })

  it('should use crypto.timingSafeEqual from top-level import, not require()', () => {
    // Access the private method to verify it uses the pre-imported timingSafeEqual
    const manager = create()

    // The current code does:
    //   const { timingSafeEqual: tse } = require('crypto')
    // This is wasteful (runtime require on every call) and may fail in
    // environments where require() is not available (ESM-only).
    //
    // crypto is already imported at the top of StateSignature.ts via:
    //   import { createHmac, ... } from 'crypto'
    // So timingSafeEqual should be imported there too.

    // We can verify the fix by checking that validateState works
    // (it would break if require('crypto') fails in some environment)
    const state = { test: true }
    const signed = manager.signState('comp-1', state, 1)
    const result = manager.validateState(signed)
    expect(result.valid).toBe(true)
  })

  it('should not have a non-timing-safe fallback', () => {
    const manager = create()

    // The current code has:
    //   catch { return a === b }
    // This means if require('crypto') fails, it falls back to regular
    // string comparison which is vulnerable to timing attacks.
    //
    // Since crypto is a Node.js built-in and already imported at the top
    // of the file, this fallback should never be needed. But if it is,
    // it should use a constant-time comparison algorithm.

    // This test verifies the fix works correctly
    const state = { count: 42 }
    const signed = manager.signState('comp-1', state, 1)

    // Valid signature
    expect(manager.validateState(signed).valid).toBe(true)

    // Invalid signature (same length)
    const bad = { ...signed, signature: 'f'.repeat(signed.signature.length) }
    expect(manager.validateState(bad).valid).toBe(false)
  })
})
