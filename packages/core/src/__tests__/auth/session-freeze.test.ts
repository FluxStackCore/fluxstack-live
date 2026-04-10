// Regression test for issue #4 (part 2): $auth.session mutability.
//
// Before the fix, AuthenticatedContext stored `session` by reference and
// did not freeze it, so a handler bug that mutated `this.$auth.session.roles`
// or `.id` silently altered subsequent authorize() decisions within the
// same process. The fix deep-copies and freezes the session (plus the
// roles/permissions arrays) and freezes the context instance itself.

import { describe, it, expect } from 'vitest'
import { AuthenticatedContext, ANONYMOUS_CONTEXT } from '../../auth/LiveAuthContext'

describe('AuthenticatedContext — session immutability (issue #4 part 2)', () => {
  it('direct mutation of session.id throws in strict mode and has no effect', () => {
    const ctx = new AuthenticatedContext({ id: 'alice', roles: ['user'] })
    expect(() => {
      ;(ctx.session as any).id = 'bob'
    }).toThrow(TypeError)
    expect(ctx.session.id).toBe('alice')
  })

  it('assignment to session.roles (replacing the array) throws and leaves the array intact', () => {
    const ctx = new AuthenticatedContext({ id: 'alice', roles: ['user'] })
    expect(() => {
      ;(ctx.session as any).roles = ['admin']
    }).toThrow(TypeError)
    expect(ctx.session.roles).toEqual(['user'])
  })

  it('pushing onto session.roles throws — privilege escalation via mutation is blocked', () => {
    const ctx = new AuthenticatedContext({ id: 'alice', roles: ['user'] })
    expect(() => {
      ;(ctx.session.roles as any).push('admin')
    }).toThrow(TypeError)
    expect(ctx.hasRole('admin')).toBe(false)
    expect(ctx.hasRole('user')).toBe(true)
  })

  it('pushing onto session.permissions throws', () => {
    const ctx = new AuthenticatedContext({ id: 'alice', permissions: ['read'] })
    expect(() => {
      ;(ctx.session.permissions as any).push('write')
    }).toThrow(TypeError)
    expect(ctx.hasPermission('write')).toBe(false)
  })

  it('mutating the original source object after construction does not leak into the context', () => {
    // The constructor copies roles/permissions — so mutating the caller's
    // original object cannot affect what the context sees.
    const source = { id: 'alice', roles: ['user'] as string[], permissions: ['read'] as string[] }
    const ctx = new AuthenticatedContext(source)
    source.roles.push('admin')
    source.permissions.push('write')
    expect(ctx.session.roles).toEqual(['user'])
    expect(ctx.session.permissions).toEqual(['read'])
    expect(ctx.hasRole('admin')).toBe(false)
    expect(ctx.hasPermission('write')).toBe(false)
  })

  it('the context instance itself is frozen — cannot replace session', () => {
    const ctx = new AuthenticatedContext({ id: 'alice', roles: ['user'] })
    expect(() => {
      ;(ctx as any).session = { id: 'bob', roles: ['admin'] }
    }).toThrow(TypeError)
    expect(ctx.session.id).toBe('alice')
  })

  it('ANONYMOUS_CONTEXT singleton is frozen', () => {
    expect(Object.isFrozen(ANONYMOUS_CONTEXT)).toBe(true)
    expect(() => {
      ;(ANONYMOUS_CONTEXT as any).authenticated = true
    }).toThrow(TypeError)
    expect(ANONYMOUS_CONTEXT.authenticated).toBe(false)
  })

  it('sessions without roles/permissions still freeze cleanly', () => {
    const ctx = new AuthenticatedContext({ id: 'u' })
    expect(Object.isFrozen(ctx.session)).toBe(true)
    expect(Object.isFrozen(ctx)).toBe(true)
    // Without roles, hasRole is trivially false; this must not throw.
    expect(ctx.hasRole('admin')).toBe(false)
  })
})
