import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { LiveAuthManager } from '../../auth/LiveAuthManager'
import { ANONYMOUS_CONTEXT } from '../../auth/LiveAuthContext'
import {
  createSuccessProvider,
  createFailingProvider,
  createReturnsNullProvider,
  spyOnConsole,
} from '../helpers'

describe('LiveAuthManager', () => {
  let manager: LiveAuthManager
  let consoleSpy: ReturnType<typeof spyOnConsole>

  beforeEach(() => {
    manager = new LiveAuthManager()
    consoleSpy = spyOnConsole()
  })

  afterEach(() => {
    consoleSpy.restore()
  })

  describe('authenticate() - provider error handling', () => {
    it('should warn when a provider throws an exception', async () => {
      const error = new Error('Database connection failed')
      manager.register(createFailingProvider('failing-db', error))

      const result = await manager.authenticate({ token: 'some-token' })

      expect(result.authenticated).toBe(false)
      expect(result).toBe(ANONYMOUS_CONTEXT)

      // Should have logged a per-provider warning
      const perProviderWarns = consoleSpy.calls.warn.filter(
        args => typeof args[0] === 'string' && args[0].includes("'failing-db' threw"),
      )
      expect(perProviderWarns.length).toBe(1)
      expect(perProviderWarns[0][1]).toBe('Database connection failed')

      // Should have logged a summary warning
      const summaryWarns = consoleSpy.calls.warn.filter(
        args => typeof args[0] === 'string' && args[0].includes('All 1 provider(s) failed'),
      )
      expect(summaryWarns.length).toBe(1)
    })

    it('should try next provider when one returns null (no error log)', async () => {
      const nullProvider = createReturnsNullProvider('null-provider')
      const successProvider = createSuccessProvider('jwt', { id: 'user-1', roles: ['admin'] })

      manager.register(nullProvider)
      manager.register(successProvider)

      const result = await manager.authenticate({ token: 'valid' })

      expect(result.authenticated).toBe(true)
      expect(result.user?.id).toBe('user-1')

      // No warnings should be logged for null returns
      const providerWarns = consoleSpy.calls.warn.filter(
        args => typeof args[0] === 'string' && args[0].includes('threw'),
      )
      expect(providerWarns.length).toBe(0)
    })

    it('should return valid context immediately when provider succeeds', async () => {
      const provider = createSuccessProvider('jwt', { id: 'user-42', roles: ['editor'] })
      manager.register(provider)

      const result = await manager.authenticate({ token: 'valid-token' })

      expect(result.authenticated).toBe(true)
      expect(result.user?.id).toBe('user-42')
      expect(result.user?.roles).toContain('editor')
    })

    it('should return ANONYMOUS_CONTEXT when all providers fail', async () => {
      manager.register(createFailingProvider('p1', new Error('fail 1')))
      manager.register(createFailingProvider('p2', new Error('fail 2')))

      const result = await manager.authenticate({ token: 'some-token' })

      expect(result).toBe(ANONYMOUS_CONTEXT)
      expect(result.authenticated).toBe(false)

      // Both provider-level warnings + summary warning
      const allWarns = consoleSpy.calls.warn.filter(
        args => typeof args[0] === 'string' && args[0].includes('[Auth]'),
      )
      // 2 per-provider + 1 summary = 3
      expect(allWarns.length).toBe(3)
    })

    it('should try default provider first', async () => {
      const callOrder: string[] = []

      manager.register({
        name: 'secondary',
        async authenticate() {
          callOrder.push('secondary')
          return null
        },
      })

      manager.register({
        name: 'primary',
        async authenticate() {
          callOrder.push('primary')
          return null
        },
      })

      // First registered becomes default
      await manager.authenticate({ token: 'test' })

      expect(callOrder[0]).toBe('secondary') // default (first registered)
      expect(callOrder[1]).toBe('primary')
    })
  })

  describe('authenticate() - edge cases', () => {
    it('should return ANONYMOUS_CONTEXT for empty credentials', async () => {
      manager.register(createSuccessProvider('jwt', { id: 'user-1' }))

      const result = await manager.authenticate({})
      expect(result).toBe(ANONYMOUS_CONTEXT)
    })

    it('should return ANONYMOUS_CONTEXT when no providers registered', async () => {
      const result = await manager.authenticate({ token: 'valid' })
      expect(result).toBe(ANONYMOUS_CONTEXT)
    })
  })
})
