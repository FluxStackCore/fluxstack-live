import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ComponentRegistry } from '../../component/ComponentRegistry'
import { StateSignatureManager } from '../../security/StateSignature'
import { LiveAuthManager } from '../../auth/LiveAuthManager'
import { createMockWS, spyOnConsole } from '../helpers'

// Minimal mock deps for ComponentRegistry
function createTestRegistry() {
  const authManager = new LiveAuthManager()
  const stateSignature = new StateSignatureManager({ secret: 'test-secret-32chars-minimum-ok!' })

  const debugger_ = {
    trackComponentMount: () => {},
    trackComponentUnmount: () => {},
    trackAction: () => {},
    trackStateChange: () => {},
    isEnabled: false,
  }

  const performanceMonitor = {
    initializeComponent: () => {},
    recordRenderTime: () => {},
    recordActionTime: () => {},
    removeComponent: () => {},
  }

  const registry = new ComponentRegistry({
    authManager,
    debugger: debugger_ as any,
    stateSignature,
    performanceMonitor: performanceMonitor as any,
  })

  return { registry, stateSignature, authManager }
}

// Minimal LiveComponent-like class for testing
class FakeComponent {
  static componentName = 'FakeComponent'
  id: string
  state: Record<string, unknown>
  userId?: string
  room?: string

  constructor(initialState: any, _ws: any, options?: { room?: string; userId?: string }) {
    this.id = `fake-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    this.state = { ...initialState }
    this.userId = options?.userId
    this.room = options?.room
  }

  getSerializableState() { return { ...this.state } }
  setState(partial: any) { Object.assign(this.state, partial) }
  setAuthContext() {}
  executeAction() { return null }
  destroy() {}
  emit() {}
  onConnect() {}
  onMount() {}
  onDisconnect() {}
  onRehydrate() {}
}

describe('ComponentRegistry.rehydrateComponent - __componentName validation', () => {
  let consoleSpy: ReturnType<typeof spyOnConsole>

  beforeEach(() => {
    consoleSpy = spyOnConsole()
  })

  afterEach(() => {
    consoleSpy.restore()
  })

  it('should succeed when __componentName matches', async () => {
    const { registry, stateSignature } = createTestRegistry()
    registry.registerComponentClass('FakeComponent', FakeComponent as any)

    const signedState = await stateSignature.signState('comp-1', {
      count: 42,
      __componentName: 'FakeComponent',
    }, 1)

    const ws = createMockWS()
    const result = await registry.rehydrateComponent('comp-1', 'FakeComponent', signedState, ws)

    expect(result.success).toBe(true)
    expect(result.newComponentId).toBeDefined()
  })

  it('should REJECT when __componentName is absent', async () => {
    const { registry, stateSignature } = createTestRegistry()
    registry.registerComponentClass('FakeComponent', FakeComponent as any)

    // Sign state WITHOUT __componentName
    const signedState = await stateSignature.signState('comp-1', {
      count: 42,
    }, 1)

    const ws = createMockWS()
    const result = await registry.rehydrateComponent('comp-1', 'FakeComponent', signedState, ws)

    expect(result.success).toBe(false)
    expect(result.error).toContain('Component class mismatch')
  })

  it('should REJECT when __componentName does not match', async () => {
    const { registry, stateSignature } = createTestRegistry()
    registry.registerComponentClass('FakeComponent', FakeComponent as any)

    // Sign state with WRONG __componentName
    const signedState = await stateSignature.signState('comp-1', {
      count: 42,
      __componentName: 'MaliciousComponent',
    }, 1)

    const ws = createMockWS()
    const result = await registry.rehydrateComponent('comp-1', 'FakeComponent', signedState, ws)

    expect(result.success).toBe(false)
    expect(result.error).toContain('Component class mismatch')
  })
})
