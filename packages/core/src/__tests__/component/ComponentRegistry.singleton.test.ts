import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ComponentRegistry } from '../../component/ComponentRegistry'
import { StateSignatureManager } from '../../security/StateSignature'
import { LiveAuthManager } from '../../auth/LiveAuthManager'
import { ANONYMOUS_CONTEXT, AuthenticatedContext } from '../../auth/LiveAuthContext'
import { createMockWS, createAuthenticatedWS, spyOnConsole } from '../helpers'

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

// Singleton component WITH auth required
class AuthSingleton {
  static componentName = 'AuthSingleton'
  static singleton = true
  static auth = { required: true }

  id: string
  state: Record<string, unknown>
  userId?: string
  room?: string

  constructor(initialState: any, _ws: any, options?: { room?: string; userId?: string }) {
    this.id = `auth-singleton-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
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
  onClientJoin() {}
  onClientLeave() {}
  broadcastToRoom: any = () => {}
}

// Singleton component WITH role-based auth
class AdminSingleton {
  static componentName = 'AdminSingleton'
  static singleton = true
  static auth = { roles: ['admin'] }

  id: string
  state: Record<string, unknown>
  userId?: string
  room?: string

  constructor(initialState: any, _ws: any, options?: { room?: string; userId?: string }) {
    this.id = `admin-singleton-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
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
  onClientJoin() {}
  onClientLeave() {}
  broadcastToRoom: any = () => {}
}

// Singleton WITHOUT auth
class OpenSingleton {
  static componentName = 'OpenSingleton'
  static singleton = true

  id: string
  state: Record<string, unknown>
  userId?: string
  room?: string

  constructor(initialState: any, _ws: any, options?: { room?: string; userId?: string }) {
    this.id = `open-singleton-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
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
  onClientJoin() {}
  onClientLeave() {}
  broadcastToRoom: any = () => {}
}

describe('ComponentRegistry - Singleton auth enforcement', () => {
  let consoleSpy: ReturnType<typeof spyOnConsole>

  beforeEach(() => {
    consoleSpy = spyOnConsole()
  })

  afterEach(() => {
    consoleSpy.restore()
  })

  it('should REJECT anonymous connection to singleton with auth.required', async () => {
    const { registry } = createTestRegistry()
    registry.registerComponentClass('AuthSingleton', AuthSingleton as any)

    const ws = createMockWS() // anonymous

    await expect(
      registry.mountComponent(ws, 'AuthSingleton'),
    ).rejects.toThrow('AUTH_DENIED')
  })

  it('should REJECT user without role for singleton with auth.roles', async () => {
    const { registry } = createTestRegistry()
    registry.registerComponentClass('AdminSingleton', AdminSingleton as any)

    // Authenticated but NOT admin
    const ws = createAuthenticatedWS({ id: 'user-1', roles: ['viewer'] })

    await expect(
      registry.mountComponent(ws, 'AdminSingleton'),
    ).rejects.toThrow('AUTH_DENIED')
  })

  it('should ACCEPT user with correct role for singleton', async () => {
    const { registry } = createTestRegistry()
    registry.registerComponentClass('AdminSingleton', AdminSingleton as any)

    const ws = createAuthenticatedWS({ id: 'admin-1', roles: ['admin'] })

    const result = await registry.mountComponent(ws, 'AdminSingleton')
    expect(result.componentId).toBeDefined()
  })

  it('should ACCEPT any connection to singleton without auth config', async () => {
    const { registry } = createTestRegistry()
    registry.registerComponentClass('OpenSingleton', OpenSingleton as any)

    const ws = createMockWS() // anonymous

    const result = await registry.mountComponent(ws, 'OpenSingleton')
    expect(result.componentId).toBeDefined()
  })

  it('should enforce auth check on EVERY connection to existing singleton', async () => {
    const { registry } = createTestRegistry()
    registry.registerComponentClass('AuthSingleton', AuthSingleton as any)

    // First connection: authenticated -> success
    const ws1 = createAuthenticatedWS({ id: 'user-1' })
    const result1 = await registry.mountComponent(ws1, 'AuthSingleton')
    expect(result1.componentId).toBeDefined()

    // Second connection: anonymous -> should be REJECTED even though singleton exists
    const ws2 = createMockWS() // anonymous
    await expect(
      registry.mountComponent(ws2, 'AuthSingleton'),
    ).rejects.toThrow('AUTH_DENIED')

    // Third connection: authenticated -> should join existing singleton
    const ws3 = createAuthenticatedWS({ id: 'user-2' })
    const result3 = await registry.mountComponent(ws3, 'AuthSingleton')
    expect(result3.componentId).toBe(result1.componentId) // same singleton instance
  })
})
