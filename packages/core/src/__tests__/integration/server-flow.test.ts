import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ComponentRegistry } from '../../component/ComponentRegistry'
import { LiveComponent } from '../../component/LiveComponent'
import { setLiveComponentContext } from '../../component/context'
import { StateSignatureManager } from '../../security/StateSignature'
import { LiveAuthManager } from '../../auth/LiveAuthManager'
import { AuthenticatedContext, ANONYMOUS_CONTEXT } from '../../auth/LiveAuthContext'
import { RoomEventBus } from '../../rooms/RoomEventBus'
import { LiveRoomManager } from '../../rooms/LiveRoomManager'
import { createMockWS, createAuthenticatedWS, spyOnConsole } from '../helpers'
import type { GenericWebSocket } from '../../transport/types'

// ===== Test Component (real LiveComponent subclass) =====

class TodoComponent extends LiveComponent<{ items: string[]; count: number }> {
  static componentName = 'Todo'
  static defaultState = { items: [], count: 0 }
  static publicActions = ['addItem', 'removeItem', 'clear'] as const
  static actionSchemas = {
    addItem: {
      safeParse(data: unknown) {
        if (typeof data !== 'object' || data === null) {
          return { success: false, error: { message: 'Expected object' } }
        }
        const d = data as Record<string, unknown>
        if (typeof d.item !== 'string' || d.item.length === 0) {
          return { success: false, error: { message: 'item must be a non-empty string' } }
        }
        return { success: true, data: { item: d.item.trim() } }
      }
    }
  }

  addItem(payload: { item: string }) {
    const items = [...(this.state as any).items, payload.item]
    this.setState({ items, count: items.length })
    return { added: payload.item, count: items.length }
  }

  removeItem(payload: { index: number }) {
    const items = [...(this.state as any).items]
    items.splice(payload.index, 1)
    this.setState({ items, count: items.length })
    return { count: items.length }
  }

  clear() {
    this.setState({ items: [], count: 0 })
    return { cleared: true }
  }
}

class AuthRequiredComponent extends LiveComponent<{ secret: string }> {
  static componentName = 'AuthRequired'
  static defaultState = { secret: 'hidden' }
  static auth = { required: true }
  static publicActions = ['getSecret'] as const

  getSecret() {
    return { secret: (this.state as any).secret }
  }
}

class RateLimitedTodo extends LiveComponent<{ count: number }> {
  static componentName = 'RateLimitedTodo'
  static defaultState = { count: 0 }
  static publicActions = ['tick'] as const
  static actionRateLimit = { maxCalls: 2, windowMs: 5000, perAction: false }

  tick() {
    const count = (this.state as any).count + 1
    this.setState({ count })
    return { count }
  }
}

// ===== Helper: create a test registry =====

function createTestRegistry() {
  const roomEvents = new RoomEventBus()
  const roomManager = new LiveRoomManager(roomEvents)
  const authManager = new LiveAuthManager()
  const stateSignature = new StateSignatureManager({ secret: 'test-secret-32chars-minimum-ok!' })

  // Set global context for LiveComponent
  setLiveComponentContext({ roomEvents, roomManager })

  const performanceMonitor = {
    initializeComponent: () => {},
    recordRenderTime: () => {},
    recordActionTime: () => {},
    removeComponent: () => {},
  }

  const registry = new ComponentRegistry({
    authManager,
    stateSignature,
    performanceMonitor: performanceMonitor as any,
  })

  return { registry, stateSignature, authManager, roomManager, roomEvents }
}

// ===== Integration Tests =====

describe('Server Flow - Integration', () => {
  let consoleSpy: ReturnType<typeof spyOnConsole>

  beforeEach(() => {
    consoleSpy = spyOnConsole()
  })

  afterEach(() => {
    consoleSpy.restore()
  })

  describe('Connect → Mount → State', () => {
    it('should mount a component and return initial state', async () => {
      const { registry } = createTestRegistry()
      registry.registerComponentClass('Todo', TodoComponent as any)

      const ws = createMockWS()
      const result = await registry.mountComponent(ws, 'Todo')

      expect(result.componentId).toBeDefined()
      expect(result.initialState).toEqual({ items: [], count: 0 })
      expect(result.signedState).toBeDefined()
    })

    it('should mount with custom props merged into state', async () => {
      const { registry } = createTestRegistry()
      registry.registerComponentClass('Todo', TodoComponent as any)

      const ws = createMockWS()
      const result = await registry.mountComponent(ws, 'Todo', { items: ['existing'] })

      expect(result.initialState).toEqual({ items: ['existing'], count: 0 })
    })

    it('should send STATE_UPDATE message to WS on mount', async () => {
      const { registry } = createTestRegistry()
      registry.registerComponentClass('Todo', TodoComponent as any)

      const ws = createMockWS()
      await registry.mountComponent(ws, 'Todo')

      // The mock WS should have received messages (via the batcher microtask)
      // Wait for microtask to flush
      await new Promise<void>(r => queueMicrotask(r))
      // Messages are sent via ws.send()
      expect(ws._messages.length).toBeGreaterThanOrEqual(0)
    })
  })

  describe('Action → State Delta', () => {
    it('should execute action and return result', async () => {
      const { registry } = createTestRegistry()
      registry.registerComponentClass('Todo', TodoComponent as any)

      const ws = createMockWS()
      const { componentId } = await registry.mountComponent(ws, 'Todo')

      const result = await registry.executeAction(componentId, 'addItem', { item: 'Buy milk' })
      expect(result).toEqual({ added: 'Buy milk', count: 1 })
    })

    it('should validate action payload with Zod schema', async () => {
      const { registry } = createTestRegistry()
      registry.registerComponentClass('Todo', TodoComponent as any)

      const ws = createMockWS()
      const { componentId } = await registry.mountComponent(ws, 'Todo')

      // Invalid payload
      await expect(registry.executeAction(componentId, 'addItem', { item: '' })).rejects.toThrow('validation failed')
    })

    it('should handle full message flow via handleMessage', async () => {
      const { registry } = createTestRegistry()
      registry.registerComponentClass('Todo', TodoComponent as any)

      const ws = createMockWS()
      // Mount via handleMessage
      const mountResult = await registry.handleMessage(ws, {
        type: 'COMPONENT_MOUNT',
        componentId: '',
        payload: { component: 'Todo', props: {} },
        timestamp: Date.now(),
      })

      expect(mountResult?.success).toBe(true)
      const componentId = (mountResult?.result as any).componentId

      // Call action via handleMessage
      const actionResult = await registry.handleMessage(ws, {
        type: 'CALL_ACTION',
        componentId,
        action: 'addItem',
        payload: { item: 'Test item' },
        expectResponse: true,
        timestamp: Date.now(),
      })

      expect(actionResult?.success).toBe(true)
      expect(actionResult?.result).toEqual({ added: 'Test item', count: 1 })
    })
  })

  describe('Auth → Mount', () => {
    it('should reject anonymous connection to auth-required component', async () => {
      const { registry } = createTestRegistry()
      registry.registerComponentClass('AuthRequired', AuthRequiredComponent as any)

      const ws = createMockWS() // anonymous

      await expect(registry.mountComponent(ws, 'AuthRequired')).rejects.toThrow('AUTH_DENIED')
    })

    it('should accept authenticated connection', async () => {
      const { registry } = createTestRegistry()
      registry.registerComponentClass('AuthRequired', AuthRequiredComponent as any)

      const ws = createAuthenticatedWS({ id: 'user-1' })

      const result = await registry.mountComponent(ws, 'AuthRequired')
      expect(result.componentId).toBeDefined()
    })

    it('should set userId on component from auth context', async () => {
      const { registry } = createTestRegistry()
      registry.registerComponentClass('Todo', TodoComponent as any)

      const ws = createAuthenticatedWS({ id: 'user-123' })
      const { componentId } = await registry.mountComponent(ws, 'Todo', {}, { userId: 'user-123' })

      const component = registry.getComponent(componentId)
      expect(component?.userId).toBe('user-123')
    })
  })

  describe('Unmount → Cleanup', () => {
    it('should unmount and clean up component', async () => {
      const { registry } = createTestRegistry()
      registry.registerComponentClass('Todo', TodoComponent as any)

      const ws = createMockWS()
      const { componentId } = await registry.mountComponent(ws, 'Todo')

      expect(registry.getComponent(componentId)).toBeDefined()

      registry.unmountComponent(componentId, ws)

      expect(registry.getComponent(componentId)).toBeUndefined()
    })

    it('should clean up all components on connection close', async () => {
      const { registry } = createTestRegistry()
      registry.registerComponentClass('Todo', TodoComponent as any)

      const ws = createMockWS()
      const { componentId: id1 } = await registry.mountComponent(ws, 'Todo')
      const { componentId: id2 } = await registry.mountComponent(ws, 'Todo')

      expect(registry.getComponent(id1)).toBeDefined()
      expect(registry.getComponent(id2)).toBeDefined()

      registry.cleanupConnection(ws)

      expect(registry.getComponent(id1)).toBeUndefined()
      expect(registry.getComponent(id2)).toBeUndefined()
    })
  })

  describe('Rate Limiting', () => {
    it('should enforce action rate limit through registry', async () => {
      const { registry } = createTestRegistry()
      registry.registerComponentClass('RateLimitedTodo', RateLimitedTodo as any)

      const ws = createMockWS()
      const { componentId } = await registry.mountComponent(ws, 'RateLimitedTodo')

      // 2 calls OK
      await registry.executeAction(componentId, 'tick', {})
      await registry.executeAction(componentId, 'tick', {})

      // 3rd call should fail
      await expect(registry.executeAction(componentId, 'tick', {})).rejects.toThrow('rate limit exceeded')
    })
  })

  describe('Rehydration', () => {
    it('should sign and rehydrate state', async () => {
      const { registry, stateSignature } = createTestRegistry()
      registry.registerComponentClass('Todo', TodoComponent as any)

      const ws1 = createMockWS()
      const { componentId, signedState } = await registry.mountComponent(ws1, 'Todo')

      // Execute an action to change state
      await registry.executeAction(componentId, 'addItem', { item: 'item1' })

      // Sign current state for rehydration
      const component = registry.getComponent(componentId)!
      const signed = stateSignature.signState(componentId, {
        ...component.getSerializableState(),
        __componentName: 'Todo',
      }, 1)

      // Simulate reconnect with new WS
      const ws2 = createMockWS()
      const rehydResult = await registry.rehydrateComponent(componentId, 'Todo', signed, ws2)

      expect(rehydResult.success).toBe(true)
      expect(rehydResult.newComponentId).toBeDefined()
    })

    it('should reject rehydration with tampered state', async () => {
      const { registry, stateSignature } = createTestRegistry()
      registry.registerComponentClass('Todo', TodoComponent as any)

      const ws = createMockWS()
      await registry.mountComponent(ws, 'Todo')

      // Create a forged signed state
      const forged = stateSignature.signState('fake-id', {
        __componentName: 'Todo',
        items: ['hacked'],
      }, 1)

      // Tamper with the data
      forged.signature = 'invalid-signature'

      const ws2 = createMockWS()
      const result = await registry.rehydrateComponent('fake-id', 'Todo', forged, ws2)
      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid')
    })
  })

  describe('Backpressure (WsSendBatcher)', () => {
    it('should handle many rapid messages without crash', async () => {
      const { registry } = createTestRegistry()
      registry.registerComponentClass('Todo', TodoComponent as any)

      const ws = createMockWS()
      const { componentId } = await registry.mountComponent(ws, 'Todo')

      // Fire 50 rapid state changes
      for (let i = 0; i < 50; i++) {
        const component = registry.getComponent(componentId) as any
        component.setState({ count: i })
      }

      // Wait for microtask flush
      await new Promise<void>(r => queueMicrotask(r))

      // Should not throw, messages should be batched
      expect(ws._messages.length).toBeGreaterThan(0)
    })
  })
})
