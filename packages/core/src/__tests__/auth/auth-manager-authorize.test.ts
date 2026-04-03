import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { LiveAuthManager } from '../../auth/LiveAuthManager'
import { ANONYMOUS_CONTEXT, AuthenticatedContext } from '../../auth/LiveAuthContext'
import { spyOnConsole } from '../helpers'
import type { LiveComponentAuth, LiveActionAuth } from '../../auth/types'

describe('LiveAuthManager - authorize()', () => {
  let manager: LiveAuthManager
  let consoleSpy: ReturnType<typeof spyOnConsole>

  const adminCtx = new AuthenticatedContext(
    { id: 'user-1', roles: ['admin'], permissions: ['read', 'write'] },
    'token-admin',
  )

  const userCtx = new AuthenticatedContext(
    { id: 'user-2', roles: ['user'], permissions: ['read'] },
    'token-user',
  )

  beforeEach(() => {
    manager = new LiveAuthManager()
    consoleSpy = spyOnConsole()
  })

  afterEach(() => {
    consoleSpy.restore()
  })

  // =========================================================================
  // 1. authorizeComponent with custom authorize()
  // =========================================================================

  describe('authorizeComponent with custom authorize()', () => {
    it('should allow when authorize returns true', async () => {
      const config: LiveComponentAuth = {
        authorize: () => true,
      }

      const result = await manager.authorizeComponent(adminCtx, config)
      expect(result).toEqual({ allowed: true })
    })

    it('should deny with default reason when authorize returns false', async () => {
      const config: LiveComponentAuth = {
        authorize: () => false,
      }

      const result = await manager.authorizeComponent(adminCtx, config)
      expect(result).toEqual({ allowed: false, reason: 'Denied by custom authorize' })
    })

    it('should deny with custom reason when authorize returns { allowed: false, reason }', async () => {
      const config: LiveComponentAuth = {
        authorize: () => ({ allowed: false, reason: 'Custom reason' }),
      }

      const result = await manager.authorizeComponent(adminCtx, config)
      expect(result).toEqual({ allowed: false, reason: 'Custom reason' })
    })

    it('should work with async authorize', async () => {
      const config: LiveComponentAuth = {
        authorize: async () => {
          await new Promise(resolve => setTimeout(resolve, 1))
          return true
        },
      }

      const result = await manager.authorizeComponent(adminCtx, config)
      expect(result).toEqual({ allowed: true })
    })

    it('should deny with async authorize returning false', async () => {
      const config: LiveComponentAuth = {
        authorize: async () => {
          await new Promise(resolve => setTimeout(resolve, 1))
          return { allowed: false, reason: 'Async denial' }
        },
      }

      const result = await manager.authorizeComponent(adminCtx, config)
      expect(result).toEqual({ allowed: false, reason: 'Async denial' })
    })

    it('should deny with error message when authorize throws', async () => {
      const config: LiveComponentAuth = {
        authorize: () => { throw new Error('Something went wrong') },
      }

      const result = await manager.authorizeComponent(adminCtx, config)
      expect(result).toEqual({ allowed: false, reason: 'Authorization error: Something went wrong' })
    })

    it('should not run authorize when declarative roles check fails', async () => {
      let authorizeCalled = false
      const config: LiveComponentAuth = {
        roles: ['superadmin'],
        authorize: () => {
          authorizeCalled = true
          return true
        },
      }

      const result = await manager.authorizeComponent(userCtx, config)

      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('Insufficient roles')
      expect(authorizeCalled).toBe(false)
    })

    it('should not run authorize when declarative permissions check fails', async () => {
      let authorizeCalled = false
      const config: LiveComponentAuth = {
        permissions: ['write', 'delete'],
        authorize: () => {
          authorizeCalled = true
          return true
        },
      }

      // userCtx only has 'read' permission, missing 'write' and 'delete'
      const result = await manager.authorizeComponent(userCtx, config)

      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('Insufficient permissions')
      expect(authorizeCalled).toBe(false)
    })

    it('should not run authorize when required check fails (unauthenticated)', async () => {
      let authorizeCalled = false
      const config: LiveComponentAuth = {
        required: true,
        authorize: () => {
          authorizeCalled = true
          return true
        },
      }

      const result = await manager.authorizeComponent(ANONYMOUS_CONTEXT, config)

      expect(result.allowed).toBe(false)
      expect(result.reason).toBe('Authentication required')
      expect(authorizeCalled).toBe(false)
    })

    it('should run authorize after declarative checks pass', async () => {
      let authorizeCalled = false
      const config: LiveComponentAuth = {
        required: true,
        roles: ['admin'],
        authorize: () => {
          authorizeCalled = true
          return true
        },
      }

      const result = await manager.authorizeComponent(adminCtx, config)

      expect(result).toEqual({ allowed: true })
      expect(authorizeCalled).toBe(true)
    })
  })

  // =========================================================================
  // 2. authorizeAction with custom authorize()
  // =========================================================================

  describe('authorizeAction with custom authorize()', () => {
    it('should allow when authorize returns true', async () => {
      const actionAuth: LiveActionAuth = {
        authorize: () => true,
      }

      const result = await manager.authorizeAction(adminCtx, 'TestComponent', 'doStuff', actionAuth)
      expect(result).toEqual({ allowed: true })
    })

    it('should pass payload to authorize function', async () => {
      let receivedPayload: unknown
      const actionAuth: LiveActionAuth = {
        authorize: (_auth, payload) => {
          receivedPayload = payload
          return true
        },
      }

      const testPayload = { userId: 'u-123', data: [1, 2, 3] }
      await manager.authorizeAction(adminCtx, 'TestComponent', 'doStuff', actionAuth, undefined, testPayload)

      expect(receivedPayload).toEqual(testPayload)
    })

    it('should deny with default reason when authorize returns false', async () => {
      const actionAuth: LiveActionAuth = {
        authorize: () => false,
      }

      const result = await manager.authorizeAction(adminCtx, 'TestComponent', 'doStuff', actionAuth)
      expect(result).toEqual({ allowed: false, reason: "Action 'doStuff' denied by custom authorize" })
    })

    it('should deny with custom reason when authorize returns { allowed: false, reason }', async () => {
      const actionAuth: LiveActionAuth = {
        authorize: () => ({ allowed: false, reason: 'Not the owner' }),
      }

      const result = await manager.authorizeAction(adminCtx, 'TestComponent', 'edit', actionAuth)
      expect(result).toEqual({ allowed: false, reason: 'Not the owner' })
    })

    it('should work with async authorize', async () => {
      const actionAuth: LiveActionAuth = {
        authorize: async () => {
          await new Promise(resolve => setTimeout(resolve, 1))
          return true
        },
      }

      const result = await manager.authorizeAction(adminCtx, 'TestComponent', 'doStuff', actionAuth)
      expect(result).toEqual({ allowed: true })
    })

    it('should deny when async authorize returns false', async () => {
      const actionAuth: LiveActionAuth = {
        authorize: async (_auth, _payload) => {
          await new Promise(resolve => setTimeout(resolve, 1))
          return false
        },
      }

      const result = await manager.authorizeAction(adminCtx, 'TestComponent', 'remove', actionAuth)
      expect(result).toEqual({ allowed: false, reason: "Action 'remove' denied by custom authorize" })
    })

    it('should deny with error message when authorize throws', async () => {
      const actionAuth: LiveActionAuth = {
        authorize: () => { throw new Error('DB timeout') },
      }

      const result = await manager.authorizeAction(adminCtx, 'TestComponent', 'save', actionAuth)
      expect(result).toEqual({ allowed: false, reason: "Action 'save' authorization error: DB timeout" })
    })

    it('should not run authorize when declarative roles check fails', async () => {
      let authorizeCalled = false
      const actionAuth: LiveActionAuth = {
        roles: ['superadmin'],
        authorize: () => {
          authorizeCalled = true
          return true
        },
      }

      const result = await manager.authorizeAction(userCtx, 'TestComponent', 'delete', actionAuth)

      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('Insufficient roles')
      expect(authorizeCalled).toBe(false)
    })

    it('should not run authorize when declarative permissions check fails', async () => {
      let authorizeCalled = false
      const actionAuth: LiveActionAuth = {
        permissions: ['write', 'delete'],
        authorize: () => {
          authorizeCalled = true
          return true
        },
      }

      const result = await manager.authorizeAction(userCtx, 'TestComponent', 'delete', actionAuth)

      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('Insufficient permissions')
      expect(authorizeCalled).toBe(false)
    })

    it('should run authorize after declarative checks pass', async () => {
      let authorizeCalled = false
      const actionAuth: LiveActionAuth = {
        roles: ['admin'],
        authorize: (_auth, _payload) => {
          authorizeCalled = true
          return true
        },
      }

      const result = await manager.authorizeAction(adminCtx, 'TestComponent', 'manage', actionAuth)

      expect(result).toEqual({ allowed: true })
      expect(authorizeCalled).toBe(true)
    })
  })

  // =========================================================================
  // 3. $auth.session (rename from user)
  // =========================================================================

  describe('AuthenticatedContext.session and deprecated user', () => {
    it('should expose session on AuthenticatedContext', () => {
      const session = { id: 'sess-1', roles: ['editor'], permissions: ['edit'] }
      const ctx = new AuthenticatedContext(session, 'tok')

      expect(ctx.session).toBe(session)
      expect(ctx.session.id).toBe('sess-1')
      expect(ctx.session.roles).toEqual(['editor'])
    })

    it('should return the same reference for deprecated user as session', () => {
      const session = { id: 'sess-2', roles: ['admin'] }
      const ctx = new AuthenticatedContext(session)

      expect(ctx.user).toBe(ctx.session)
    })

    it('should read roles from session.roles in hasRole', () => {
      const ctx = new AuthenticatedContext({ id: 'u1', roles: ['moderator', 'admin'] })

      expect(ctx.hasRole('admin')).toBe(true)
      expect(ctx.hasRole('moderator')).toBe(true)
      expect(ctx.hasRole('superadmin')).toBe(false)
    })

    it('should read roles from session.roles in hasAnyRole', () => {
      const ctx = new AuthenticatedContext({ id: 'u1', roles: ['user'] })

      expect(ctx.hasAnyRole(['admin', 'user'])).toBe(true)
      expect(ctx.hasAnyRole(['admin', 'superadmin'])).toBe(false)
    })

    it('should have undefined session on ANONYMOUS_CONTEXT', () => {
      expect(ANONYMOUS_CONTEXT.session).toBeUndefined()
      expect(ANONYMOUS_CONTEXT.authenticated).toBe(false)
    })

    it('should have undefined user on ANONYMOUS_CONTEXT', () => {
      expect(ANONYMOUS_CONTEXT.user).toBeUndefined()
    })

    it('should always return false for role/permission checks on ANONYMOUS_CONTEXT', () => {
      // Cast to LiveAuthContext to call with args (AnonymousContext declares no-arg overloads)
      const ctx = ANONYMOUS_CONTEXT as import('../../auth/types').LiveAuthContext
      expect(ctx.hasRole('admin')).toBe(false)
      expect(ctx.hasAnyRole(['admin'])).toBe(false)
      expect(ctx.hasAllRoles([])).toBe(false)
      expect(ctx.hasPermission('read')).toBe(false)
      expect(ctx.hasAllPermissions([])).toBe(false)
      expect(ctx.hasAnyPermission(['read'])).toBe(false)
    })
  })
})
