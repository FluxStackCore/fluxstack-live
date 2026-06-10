// A LiveAuthProvider may return ANY object shaped like LiveAuthContext — not
// necessarily an AuthenticatedContext (which deep-freezes its session). If the
// manager passes such a context through unchanged, a handler (or a bug) could do
// `this.$auth.session.roles.push('admin')` and escalate RBAC for the rest of the
// request chain. The manager must NORMALIZE authenticated contexts so the session
// is always frozen, regardless of what the provider returned.
import { describe, it, expect, beforeEach } from 'vitest'
import { LiveAuthManager } from '../../auth/LiveAuthManager'
import type { LiveAuthProvider, LiveAuthContext } from '../../auth/types'

/** A provider that returns a plain, NON-frozen authenticated context. */
function naiveProvider(name: string, roles: string[]): LiveAuthProvider {
  return {
    name,
    async authenticate(): Promise<LiveAuthContext> {
      // Plain object literal — no AuthenticatedContext, nothing frozen.
      return {
        authenticated: true,
        session: { id: 'u1', roles: [...roles], permissions: ['read'] },
        token: 't',
        hasRole: (r: string) => roles.includes(r),
        hasAnyRole: () => false,
        hasAllRoles: () => false,
        hasPermission: () => false,
        hasAllPermissions: () => false,
        hasAnyPermission: () => false,
      } as unknown as LiveAuthContext
    },
  }
}

describe('LiveAuthManager — provider context freeze normalization', () => {
  let manager: LiveAuthManager
  beforeEach(() => { manager = new LiveAuthManager() })

  it('freezes the session even when the provider returns a plain object', async () => {
    manager.register(naiveProvider('naive', ['user']))
    const ctx = await manager.authenticate({ token: 'x' })

    expect(ctx.authenticated).toBe(true)
    expect(ctx.session?.id).toBe('u1')

    // The roles array must be frozen — a privilege-escalation push must fail/no-op.
    expect(Object.isFrozen(ctx.session)).toBe(true)
    expect(Object.isFrozen(ctx.session?.roles)).toBe(true)
    expect(() => { (ctx.session as any).roles.push('admin') }).toThrow()
    expect(ctx.session?.roles).not.toContain('admin')
  })

  it('cannot replace session.id either (whole session frozen)', async () => {
    manager.register(naiveProvider('naive', ['user']))
    const ctx = await manager.authenticate({ token: 'x' })
    expect(() => { (ctx.session as any).id = 'attacker' }).toThrow()
    expect(ctx.session?.id).toBe('u1')
  })

  it('preserves roles/permissions content after normalization', async () => {
    manager.register(naiveProvider('naive', ['editor', 'user']))
    const ctx = await manager.authenticate({ token: 'x' })
    expect(ctx.session?.roles).toEqual(['editor', 'user'])
    expect(ctx.hasRole('editor')).toBe(true)
  })
})
