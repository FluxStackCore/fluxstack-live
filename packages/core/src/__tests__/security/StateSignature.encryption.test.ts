import { describe, it, expect, afterEach } from 'vitest'
import { StateSignatureManager } from '../../security/StateSignature'

describe('StateSignatureManager - Encryption key derivation', () => {
  const instances: StateSignatureManager[] = []

  function create(config: Parameters<typeof StateSignatureManager['prototype']['signState']> extends any[] ? ConstructorParameters<typeof StateSignatureManager>[0] : never) {
    const m = new StateSignatureManager(config)
    instances.push(m)
    return m
  }

  afterEach(() => {
    instances.forEach(m => m.shutdown())
    instances.length = 0
  })

  it('should encrypt and decrypt roundtrip correctly', async () => {
    const manager = create({
      secret: 'test-secret-32chars-minimum-ok!',
      encryptionEnabled: true,
    })

    const originalState = { count: 42, name: 'test', nested: { arr: [1, 2, 3] } }

    const signed = await manager.signState('comp-1', originalState, 1)
    expect(signed.encrypted).toBe(true)

    // Validate the signed state
    const validation = await manager.validateState(signed)
    expect(validation.valid).toBe(true)

    // Extract the data back
    const extracted = await manager.extractData(signed)
    expect(extracted).toEqual(originalState)
  })

  it('should produce different encrypted outputs for same input (unique IV per sign)', async () => {
    const manager = create({
      secret: 'test-secret-32chars-minimum-ok!',
      encryptionEnabled: true,
      compressionEnabled: false, // disable to isolate encryption
    })

    const state = { value: 'same-data' }

    const signed1 = await manager.signState('comp-1', state, 1)
    const signed2 = await manager.signState('comp-1', state, 2)

    // Encrypted data should differ because IV is random per operation
    expect(signed1.data).not.toBe(signed2.data)

    // But both should decrypt to the same original state
    const extracted1 = await manager.extractData(signed1)
    const extracted2 = await manager.extractData(signed2)
    expect(extracted1).toEqual(state)
    expect(extracted2).toEqual(state)
  })

  it('should derive different encryption keys for different instances with same secret', async () => {
    const managerA = create({
      secret: 'shared-secret-for-both-instances',
      encryptionEnabled: true,
      compressionEnabled: false,
    })

    const managerB = create({
      secret: 'shared-secret-for-both-instances',
      encryptionEnabled: true,
      compressionEnabled: false,
    })

    // Each instance has a random salt, so derived keys should differ
    const keyA = (managerA as any).deriveEncryptionKey() as Buffer
    const keyB = (managerB as any).deriveEncryptionKey() as Buffer

    expect(Buffer.compare(keyA, keyB)).not.toBe(0)
  })

  it('should NOT decrypt state encrypted by a different instance (different salts)', async () => {
    const managerA = create({
      secret: 'shared-secret-for-both-instances',
      encryptionEnabled: true,
      compressionEnabled: false,
    })

    const managerB = create({
      secret: 'shared-secret-for-both-instances',
      encryptionEnabled: true,
      compressionEnabled: false,
    })

    const state = { sensitive: 'data' }
    const signedByA = await managerA.signState('comp-1', state, 1)

    // Instance B should fail to decrypt since salt differs
    expect(() => managerB.extractData(signedByA)).toThrow()
  })

  it('should cache the derived key (same result on multiple calls)', async () => {
    const manager = create({
      secret: 'test-secret-32chars-minimum-ok!',
      encryptionEnabled: true,
    })

    const key1 = (manager as any).deriveEncryptionKey() as Buffer
    const key2 = (manager as any).deriveEncryptionKey() as Buffer

    // Should be the exact same Buffer reference (cached)
    expect(key1).toBe(key2)
  })
})
