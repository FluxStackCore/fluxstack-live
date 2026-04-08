// BUG #5: Memory leak in StateSignatureManager — stateBackups never cleaned
// The stateBackups Map keeps entries for destroyed components indefinitely.
import { describe, it, expect, afterEach } from 'vitest'
import { StateSignatureManager } from '../../security/StateSignature'

describe('BUG: StateSignatureManager memory leak — backups never cleaned', () => {
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

  it('should allow clearing backups for a destroyed component', () => {
    const manager = create({ backupEnabled: true, maxBackups: 3 })

    // Simulate 100 components being created and destroyed
    for (let i = 0; i < 100; i++) {
      const componentId = `comp-${i}`
      manager.signState(componentId, { count: i }, 1, { backup: true })
    }

    // All 100 components have backups
    for (let i = 0; i < 100; i++) {
      expect(manager.getBackups(`comp-${i}`)).toHaveLength(1)
    }

    // "Destroy" component 0 — clear its backups
    // BUG: There's no public method to clear backups for a component.
    // clearBackups() should exist but doesn't.
    if (typeof (manager as any).clearBackups === 'function') {
      (manager as any).clearBackups('comp-0')
      expect(manager.getBackups('comp-0')).toHaveLength(0)
    } else {
      // BUG CONFIRMED: no way to clean up backups
      // This test will fail until clearBackups is implemented
      expect(typeof (manager as any).clearBackups).toBe('function')
    }
  })

  it('should not accumulate memory from destroyed components', () => {
    const manager = create({ backupEnabled: true, maxBackups: 3 })

    // Simulate churn: create components, sign state, then "destroy" them
    for (let i = 0; i < 1000; i++) {
      const componentId = `ephemeral-${i}`
      manager.signState(componentId, { data: 'x'.repeat(100) }, 1, { backup: true })
    }

    // All 1000 should have backups
    let totalBackups = 0
    for (let i = 0; i < 1000; i++) {
      totalBackups += manager.getBackups(`ephemeral-${i}`).length
    }
    expect(totalBackups).toBe(1000)

    // After clearing all, should be 0
    for (let i = 0; i < 1000; i++) {
      if (typeof (manager as any).clearBackups === 'function') {
        (manager as any).clearBackups(`ephemeral-${i}`)
      }
    }

    if (typeof (manager as any).clearBackups === 'function') {
      let remaining = 0
      for (let i = 0; i < 1000; i++) {
        remaining += manager.getBackups(`ephemeral-${i}`).length
      }
      expect(remaining).toBe(0)
    } else {
      // BUG: no clearBackups method exists
      expect(typeof (manager as any).clearBackups).toBe('function')
    }
  })
})
