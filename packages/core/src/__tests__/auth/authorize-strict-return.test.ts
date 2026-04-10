// Regression test for issue #4 (part 3): strict validation of the value
// returned from a user-supplied `authorize()` callback.
//
// Before the fix, LiveAuthManager treated any non-boolean return as a
// LiveAuthResult, so primitives like `'true'`, `0`, `null` or `undefined`
// were stored in `result.allowed` as `undefined`. Downstream code that
// checked `result.allowed === false` (strict equality) would miss the
// deny and allow the action. Now we coerce unknown shapes to a deny.

import { describe, it, expect } from 'vitest'
import { LiveAuthManager } from '../../auth/LiveAuthManager'
import { AuthenticatedContext } from '../../auth/LiveAuthContext'
import type { LiveActionAuth, LiveComponentAuth } from '../../auth/types'

describe('LiveAuthManager — strict authorize() return coercion (issue #4 part 3)', () => {
  const user = () => new AuthenticatedContext({ id: 'u', roles: ['user'] })

  describe('authorizeAction', () => {
    it('boolean true → allowed', async () => {
      const mgr = new LiveAuthManager()
      const cfg: LiveActionAuth = { authorize: (async () => true) as any }
      const r = await mgr.authorizeAction(user(), 'C', 'a', cfg)
      expect(r.allowed).toBe(true)
    })

    it('boolean false → denied with explicit allowed:false', async () => {
      const mgr = new LiveAuthManager()
      const cfg: LiveActionAuth = { authorize: (async () => false) as any }
      const r = await mgr.authorizeAction(user(), 'C', 'a', cfg)
      expect(r.allowed).toBe(false)
      // Strict consumers checking === false must work.
      expect(r.allowed === false).toBe(true)
    })

    it('{ allowed: true } → allowed', async () => {
      const mgr = new LiveAuthManager()
      const cfg: LiveActionAuth = { authorize: (async () => ({ allowed: true })) as any }
      const r = await mgr.authorizeAction(user(), 'C', 'a', cfg)
      expect(r.allowed).toBe(true)
    })

    it('{ allowed: false, reason } → denied with preserved reason', async () => {
      const mgr = new LiveAuthManager()
      const cfg: LiveActionAuth = {
        authorize: (async () => ({ allowed: false, reason: 'no dice' })) as any,
      }
      const r = await mgr.authorizeAction(user(), 'C', 'a', cfg)
      expect(r.allowed).toBe(false)
      expect(r.reason).toBe('no dice')
    })

    it('undefined → denied (fail-closed, strict false)', async () => {
      const mgr = new LiveAuthManager()
      const cfg: LiveActionAuth = { authorize: (async () => undefined) as any }
      const r = await mgr.authorizeAction(user(), 'C', 'a', cfg)
      expect(r.allowed === false).toBe(true) // strict check, not just falsy
    })

    it('null → denied', async () => {
      const mgr = new LiveAuthManager()
      const cfg: LiveActionAuth = { authorize: (async () => null) as any }
      const r = await mgr.authorizeAction(user(), 'C', 'a', cfg)
      expect(r.allowed === false).toBe(true)
    })

    it('number 0 → denied', async () => {
      const mgr = new LiveAuthManager()
      const cfg: LiveActionAuth = { authorize: (async () => 0) as any }
      const r = await mgr.authorizeAction(user(), 'C', 'a', cfg)
      expect(r.allowed === false).toBe(true)
    })

    it('string "true" → denied (truthy primitive must not bypass)', async () => {
      const mgr = new LiveAuthManager()
      const cfg: LiveActionAuth = { authorize: (async () => 'true') as any }
      const r = await mgr.authorizeAction(user(), 'C', 'a', cfg)
      expect(r.allowed === false).toBe(true)
      expect(typeof r).toBe('object') // must be a real LiveAuthResult, not a string
    })

    it('object without allowed key → denied', async () => {
      const mgr = new LiveAuthManager()
      const cfg: LiveActionAuth = { authorize: (async () => ({ foo: 'bar' })) as any }
      const r = await mgr.authorizeAction(user(), 'C', 'a', cfg)
      expect(r.allowed === false).toBe(true)
    })

    it('object with allowed: "yes" (wrong type) → denied', async () => {
      const mgr = new LiveAuthManager()
      const cfg: LiveActionAuth = { authorize: (async () => ({ allowed: 'yes' })) as any }
      const r = await mgr.authorizeAction(user(), 'C', 'a', cfg)
      expect(r.allowed === false).toBe(true)
    })
  })

  describe('authorizeComponent', () => {
    it('undefined → denied', async () => {
      const mgr = new LiveAuthManager()
      const cfg: LiveComponentAuth = { authorize: (async () => undefined) as any }
      const r = await mgr.authorizeComponent(user(), cfg)
      expect(r.allowed === false).toBe(true)
    })

    it('boolean true → allowed', async () => {
      const mgr = new LiveAuthManager()
      const cfg: LiveComponentAuth = { authorize: (async () => true) as any }
      const r = await mgr.authorizeComponent(user(), cfg)
      expect(r.allowed).toBe(true)
    })

    it('{ allowed: true } → allowed', async () => {
      const mgr = new LiveAuthManager()
      const cfg: LiveComponentAuth = { authorize: (async () => ({ allowed: true })) as any }
      const r = await mgr.authorizeComponent(user(), cfg)
      expect(r.allowed).toBe(true)
    })
  })
})
