// Tests for custom authorize() in LiveComponentAuth and LiveActionAuth
//
// Validates the new authorize function support:
// - Component mount with custom authorize
// - Action execution with custom authorize (receives payload)
// - Async authorize (simulated DB check)
// - authorize returning LiveAuthResult with custom reason
// - authorize combined with declarative checks (roles + authorize)
// - Reusable auth rules pattern

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ComponentRegistry } from '../../component/ComponentRegistry'
import { LiveComponent } from '../../component/LiveComponent'
import { setLiveComponentContext } from '../../component/context'
import { StateSignatureManager } from '../../security/StateSignature'
import { LiveAuthManager } from '../../auth/LiveAuthManager'
import { RoomEventBus } from '../../rooms/RoomEventBus'
import { LiveRoomManager } from '../../rooms/LiveRoomManager'
import { createMockWS, createAuthenticatedWS, spyOnConsole } from '../helpers'
import type { LiveComponentAuth, LiveActionAuthMap } from '../../auth/types'

// ===== Reusable auth rules (dev pattern) =====

const adminOnly: LiveComponentAuth = {
  required: true,
  roles: ['admin'],
}

const proOnly: LiveComponentAuth = {
  required: true,
  authorize: (auth) => {
    const plan = (auth.session as any)?.plan
    if (plan !== 'pro') {
      return { allowed: false, reason: 'Pro plan required' }
    }
    return { allowed: true }
  },
}

const adminOrPro: LiveComponentAuth = {
  required: true,
  authorize: (auth) => {
    if (auth.hasRole('admin')) return true
    const plan = (auth.session as any)?.plan
    return plan === 'pro'
  },
}

const ownerOnly = (field = 'userId') => ({
  authorize: (auth: any, payload: any) => {
    return auth.session?.id === payload?.[field]
  },
})

// ===== Test Components =====

class PublicCounter extends LiveComponent<{ count: number }> {
  static componentName = 'PublicCounter'
  static defaultState = { count: 0 }
  static publicActions = ['increment'] as const

  increment() {
    this.state.count++
    return { count: this.state.count }
  }
}

class ProOnlyDashboard extends LiveComponent<{ data: string }> {
  static componentName = 'ProOnlyDashboard'
  static defaultState = { data: 'dashboard' }
  static publicActions = ['getData'] as const
  static auth = proOnly

  getData() {
    return { data: this.state.data }
  }
}

class AdminOrProPanel extends LiveComponent<{ info: string }> {
  static componentName = 'AdminOrProPanel'
  static defaultState = { info: 'panel' }
  static publicActions = ['getInfo'] as const
  static auth = adminOrPro

  getInfo() {
    return { info: this.state.info }
  }
}

class AsyncAuthComponent extends LiveComponent<{ secret: string }> {
  static componentName = 'AsyncAuth'
  static defaultState = { secret: 'hidden' }
  static publicActions = ['getSecret'] as const
  static auth: LiveComponentAuth = {
    required: true,
    authorize: async (auth) => {
      // Simulated async DB check
      await new Promise(resolve => setTimeout(resolve, 10))
      const allowed = (auth.session as any)?.verified === true
      if (!allowed) return { allowed: false, reason: 'Account not verified' }
      return { allowed: true }
    },
  }

  getSecret() {
    return { secret: this.state.secret }
  }
}

class RolesAndAuthorizeComponent extends LiveComponent<{ value: number }> {
  static componentName = 'RolesAndAuthorize'
  static defaultState = { value: 42 }
  static publicActions = ['getValue'] as const
  static auth: LiveComponentAuth = {
    required: true,
    roles: ['editor', 'admin'],
    authorize: (auth) => {
      // Extra check on top of roles
      return (auth.session as any)?.active === true
    },
  }

  getValue() {
    return { value: this.state.value }
  }
}

class OwnerActionComponent extends LiveComponent<{ items: string[] }> {
  static componentName = 'OwnerAction'
  static defaultState = { items: [] }
  static publicActions = ['deleteItem', 'adminDelete'] as const
  static auth = { required: true }
  static actionAuth: LiveActionAuthMap = {
    deleteItem: ownerOnly('ownerId'),
    adminDelete: {
      roles: ['admin'],
      authorize: async (_auth, payload: any) => {
        // Even admins can't delete protected items
        if (payload?.itemId === 'protected') {
          return { allowed: false, reason: 'Item is protected' }
        }
        return { allowed: true }
      },
    },
  }

  deleteItem(payload: { ownerId: string; itemId: string }) {
    return { deleted: payload.itemId }
  }

  adminDelete(payload: { itemId: string }) {
    return { deleted: payload.itemId }
  }
}

class AuthorizeThrowsComponent extends LiveComponent<{ x: number }> {
  static componentName = 'AuthorizeThrows'
  static defaultState = { x: 0 }
  static publicActions = ['doStuff'] as const
  static auth: LiveComponentAuth = {
    required: true,
    authorize: () => {
      throw new Error('Database connection failed')
    },
  }

  doStuff() {
    return { ok: true }
  }
}

// ===== Helper =====

function createTestRegistry() {
  const roomEvents = new RoomEventBus()
  const roomManager = new LiveRoomManager(roomEvents)
  const authManager = new LiveAuthManager()
  const stateSignature = new StateSignatureManager({ secret: 'test-secret-32chars-minimum-ok!' })

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

  return { registry, authManager }
}

// ===== Tests =====

describe('Custom authorize() in auth', () => {
  let consoleSpy: ReturnType<typeof spyOnConsole>

  beforeEach(() => {
    consoleSpy = spyOnConsole()
  })

  afterEach(() => {
    consoleSpy.restore()
  })

  // ─── Component Auth ───

  describe('Component mount authorize', () => {
    it('should mount public component without auth', async () => {
      const { registry } = createTestRegistry()
      registry.registerComponentClass('PublicCounter', PublicCounter as any)

      const ws = createMockWS()
      const result = await registry.mountComponent(ws, 'PublicCounter')
      expect(result.componentId).toBeDefined()
      expect(result.initialState).toEqual({ count: 0 })
    })

    it('should allow mount when custom authorize returns true', async () => {
      const { registry } = createTestRegistry()
      registry.registerComponentClass('ProOnlyDashboard', ProOnlyDashboard as any)

      const ws = createAuthenticatedWS({ id: 'user-1', plan: 'pro' } as any)
      const result = await registry.mountComponent(ws, 'ProOnlyDashboard')
      expect(result.componentId).toBeDefined()
    })

    it('should deny mount when custom authorize returns false', async () => {
      const { registry } = createTestRegistry()
      registry.registerComponentClass('ProOnlyDashboard', ProOnlyDashboard as any)

      const ws = createAuthenticatedWS({ id: 'user-1', plan: 'free' } as any)
      await expect(registry.mountComponent(ws, 'ProOnlyDashboard')).rejects.toThrow('AUTH_DENIED')
    })

    it('should return custom reason from authorize', async () => {
      const { registry } = createTestRegistry()
      registry.registerComponentClass('ProOnlyDashboard', ProOnlyDashboard as any)

      const ws = createAuthenticatedWS({ id: 'user-1', plan: 'free' } as any)
      await expect(registry.mountComponent(ws, 'ProOnlyDashboard')).rejects.toThrow('Pro plan required')
    })

    it('should allow admin in adminOrPro component', async () => {
      const { registry } = createTestRegistry()
      registry.registerComponentClass('AdminOrProPanel', AdminOrProPanel as any)

      const ws = createAuthenticatedWS({ id: 'admin-1', roles: ['admin'] })
      const result = await registry.mountComponent(ws, 'AdminOrProPanel')
      expect(result.componentId).toBeDefined()
    })

    it('should allow pro user in adminOrPro component', async () => {
      const { registry } = createTestRegistry()
      registry.registerComponentClass('AdminOrProPanel', AdminOrProPanel as any)

      const ws = createAuthenticatedWS({ id: 'user-1', plan: 'pro' } as any)
      const result = await registry.mountComponent(ws, 'AdminOrProPanel')
      expect(result.componentId).toBeDefined()
    })

    it('should deny free non-admin in adminOrPro component', async () => {
      const { registry } = createTestRegistry()
      registry.registerComponentClass('AdminOrProPanel', AdminOrProPanel as any)

      const ws = createAuthenticatedWS({ id: 'user-1', plan: 'free' } as any)
      await expect(registry.mountComponent(ws, 'AdminOrProPanel')).rejects.toThrow('AUTH_DENIED')
    })

    it('should handle async authorize (simulated DB check)', async () => {
      const { registry } = createTestRegistry()
      registry.registerComponentClass('AsyncAuth', AsyncAuthComponent as any)

      // Verified user — should pass
      const wsOk = createAuthenticatedWS({ id: 'user-1', verified: true } as any)
      const result = await registry.mountComponent(wsOk, 'AsyncAuth')
      expect(result.componentId).toBeDefined()

      // Unverified user — should fail
      const wsFail = createAuthenticatedWS({ id: 'user-2', verified: false } as any)
      await expect(registry.mountComponent(wsFail, 'AsyncAuth')).rejects.toThrow('Account not verified')
    })

    it('should run authorize AFTER declarative checks', async () => {
      const { registry } = createTestRegistry()
      registry.registerComponentClass('RolesAndAuthorize', RolesAndAuthorizeComponent as any)

      // Has role but not active — authorize denies
      const ws1 = createAuthenticatedWS({ id: 'u1', roles: ['editor'], active: false } as any)
      await expect(registry.mountComponent(ws1, 'RolesAndAuthorize')).rejects.toThrow('AUTH_DENIED')

      // Wrong role — declarative check denies before authorize runs
      const ws2 = createAuthenticatedWS({ id: 'u2', roles: ['viewer'], active: true } as any)
      await expect(registry.mountComponent(ws2, 'RolesAndAuthorize')).rejects.toThrow('Insufficient roles')

      // Has role AND active — both pass
      const ws3 = createAuthenticatedWS({ id: 'u3', roles: ['admin'], active: true } as any)
      const result = await registry.mountComponent(ws3, 'RolesAndAuthorize')
      expect(result.componentId).toBeDefined()
    })

    it('should handle authorize that throws', async () => {
      const { registry } = createTestRegistry()
      registry.registerComponentClass('AuthorizeThrows', AuthorizeThrowsComponent as any)

      const ws = createAuthenticatedWS({ id: 'user-1' })
      await expect(registry.mountComponent(ws, 'AuthorizeThrows')).rejects.toThrow('Database connection failed')
    })
  })

  // ─── Action Auth ───

  describe('Action authorize', () => {
    it('should allow action when owner matches', async () => {
      const { registry } = createTestRegistry()
      registry.registerComponentClass('OwnerAction', OwnerActionComponent as any)

      const ws = createAuthenticatedWS({ id: 'user-1' })
      const { componentId } = await registry.mountComponent(ws, 'OwnerAction')

      // Owner matches — allowed
      const result = await registry.executeAction(componentId, 'deleteItem', {
        ownerId: 'user-1',
        itemId: 'item-1',
      })
      expect(result).toEqual({ deleted: 'item-1' })
    })

    it('should deny action when owner does not match', async () => {
      const { registry } = createTestRegistry()
      registry.registerComponentClass('OwnerAction', OwnerActionComponent as any)

      const ws = createAuthenticatedWS({ id: 'user-1' })
      const { componentId } = await registry.mountComponent(ws, 'OwnerAction')

      // Different owner — denied
      await expect(
        registry.executeAction(componentId, 'deleteItem', {
          ownerId: 'user-2',
          itemId: 'item-1',
        })
      ).rejects.toThrow('AUTH_DENIED')
    })

    it('should allow admin delete for normal items', async () => {
      const { registry } = createTestRegistry()
      registry.registerComponentClass('OwnerAction', OwnerActionComponent as any)

      const ws = createAuthenticatedWS({ id: 'admin-1', roles: ['admin'] })
      const { componentId } = await registry.mountComponent(ws, 'OwnerAction')

      const result = await registry.executeAction(componentId, 'adminDelete', {
        itemId: 'item-1',
      })
      expect(result).toEqual({ deleted: 'item-1' })
    })

    it('should deny admin delete for protected items', async () => {
      const { registry } = createTestRegistry()
      registry.registerComponentClass('OwnerAction', OwnerActionComponent as any)

      const ws = createAuthenticatedWS({ id: 'admin-1', roles: ['admin'] })
      const { componentId } = await registry.mountComponent(ws, 'OwnerAction')

      await expect(
        registry.executeAction(componentId, 'adminDelete', { itemId: 'protected' })
      ).rejects.toThrow('Item is protected')
    })

    it('should deny non-admin even for normal items in adminDelete', async () => {
      const { registry } = createTestRegistry()
      registry.registerComponentClass('OwnerAction', OwnerActionComponent as any)

      const ws = createAuthenticatedWS({ id: 'user-1', roles: ['user'] })
      const { componentId } = await registry.mountComponent(ws, 'OwnerAction')

      await expect(
        registry.executeAction(componentId, 'adminDelete', { itemId: 'item-1' })
      ).rejects.toThrow('Insufficient roles')
    })
  })

  // ─── Reusable rules ───

  describe('Reusable auth rules', () => {
    it('adminOnly rule should work as static auth', async () => {
      class AdminPanel extends LiveComponent<{ x: number }> {
        static componentName = 'AdminPanel'
        static defaultState = { x: 0 }
        static publicActions = ['noop'] as const
        static auth = adminOnly

        noop() { return {} }
      }

      const { registry } = createTestRegistry()
      registry.registerComponentClass('AdminPanel', AdminPanel as any)

      // Non-admin denied
      const ws1 = createAuthenticatedWS({ id: 'user-1', roles: ['user'] })
      await expect(registry.mountComponent(ws1, 'AdminPanel')).rejects.toThrow('Insufficient roles')

      // Admin allowed
      const ws2 = createAuthenticatedWS({ id: 'admin-1', roles: ['admin'] })
      const result = await registry.mountComponent(ws2, 'AdminPanel')
      expect(result.componentId).toBeDefined()
    })

    it('ownerOnly factory should work in actionAuth', async () => {
      class EditableProfile extends LiveComponent<{ name: string }> {
        static componentName = 'EditableProfile'
        static defaultState = { name: '' }
        static publicActions = ['updateName'] as const
        static auth = { required: true }
        static actionAuth: LiveActionAuthMap = {
          updateName: ownerOnly('profileUserId'),
        }

        updateName(payload: { profileUserId: string; name: string }) {
          this.setState({ name: payload.name })
          return { updated: true }
        }
      }

      const { registry } = createTestRegistry()
      registry.registerComponentClass('EditableProfile', EditableProfile as any)

      const ws = createAuthenticatedWS({ id: 'user-1' })
      const { componentId } = await registry.mountComponent(ws, 'EditableProfile')

      // Own profile — allowed
      const result = await registry.executeAction(componentId, 'updateName', {
        profileUserId: 'user-1',
        name: 'New Name',
      })
      expect(result).toEqual({ updated: true })

      // Other's profile — denied
      await expect(
        registry.executeAction(componentId, 'updateName', {
          profileUserId: 'user-2',
          name: 'Hacked',
        })
      ).rejects.toThrow('AUTH_DENIED')
    })
  })
})
