import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { LiveComponent } from '../../component/LiveComponent'
import { setLiveComponentContext } from '../../component/context'
import { RoomEventBus } from '../../rooms/RoomEventBus'
import { LiveRoomManager } from '../../rooms/LiveRoomManager'
import { createMockWS, createAuthenticatedWS, spyOnConsole } from '../helpers'

// ===== Setup minimal context =====

const roomEvents = new RoomEventBus()
const roomManager = new LiveRoomManager(roomEvents)

setLiveComponentContext({
  roomEvents,
  roomManager,
})

// ===== Test Components =====

class CounterComponent extends LiveComponent<{ count: number }> {
  static componentName = 'Counter'
  static defaultState = { count: 0 }
  static publicActions = ['increment', 'decrement', 'setValue'] as const

  increment() {
    this.setState({ count: (this.state as any).count + 1 })
    return { count: (this.state as any).count }
  }

  decrement() {
    this.setState({ count: (this.state as any).count - 1 })
    return { count: (this.state as any).count }
  }

  // Private method — should NOT be callable remotely
  private _internalReset() {
    this.setState({ count: 0 })
  }

  // Method NOT in publicActions — should be blocked
  secretMethod() {
    return 'should never reach here'
  }
}

class ValidatedComponent extends LiveComponent<{ messages: string[] }> {
  static componentName = 'Validated'
  static defaultState = { messages: [] }
  static publicActions = ['sendMessage', 'noSchemaAction'] as const

  static actionSchemas = {
    sendMessage: {
      safeParse(data: unknown) {
        if (typeof data !== 'object' || data === null) {
          return { success: false, error: { message: 'Expected object' } }
        }
        const d = data as Record<string, unknown>
        if (typeof d.text !== 'string') {
          return { success: false, error: { message: 'text must be a string' } }
        }
        if ((d.text as string).length > 100) {
          return { success: false, error: { message: 'text too long (max 100)' } }
        }
        return { success: true, data: { text: (d.text as string).trim() } }
      },
    },
  }

  sendMessage(payload: { text: string }) {
    return { sent: payload.text }
  }

  noSchemaAction(payload: any) {
    return { received: payload }
  }
}

class RateLimitedComponent extends LiveComponent<{ count: number }> {
  static componentName = 'RateLimited'
  static defaultState = { count: 0 }
  static publicActions = ['doAction', 'otherAction'] as const
  static actionRateLimit = { maxCalls: 3, windowMs: 1000, perAction: false }

  doAction() {
    return { ok: true }
  }

  otherAction() {
    return { ok: true }
  }
}

class PerActionRateLimitedComponent extends LiveComponent<{ count: number }> {
  static componentName = 'PerActionRateLimited'
  static defaultState = { count: 0 }
  static publicActions = ['actionA', 'actionB'] as const
  static actionRateLimit = { maxCalls: 2, windowMs: 1000, perAction: true }

  actionA() {
    return { action: 'A' }
  }

  actionB() {
    return { action: 'B' }
  }
}

class NoPublicActionsComponent extends LiveComponent<{ value: number }> {
  static componentName = 'NoPublicActions'
  static defaultState = { value: 0 }
  // Intentionally NO publicActions defined

  doSomething() {
    return 'should not reach'
  }
}

// ===== Tests =====

describe('Action Security', () => {
  let consoleSpy: ReturnType<typeof spyOnConsole>

  beforeEach(() => {
    consoleSpy = spyOnConsole()
  })

  afterEach(() => {
    consoleSpy.restore()
  })

  describe('BLOCKED_ACTIONS', () => {
    it('should block constructor', async () => {
      const ws = createMockWS()
      const comp = new CounterComponent({}, ws)
      await expect(comp.executeAction('constructor', {})).rejects.toThrow('not callable')
    })

    it('should block destroy', async () => {
      const ws = createMockWS()
      const comp = new CounterComponent({}, ws)
      await expect(comp.executeAction('destroy', {})).rejects.toThrow('not callable')
    })

    it('should block executeAction itself', async () => {
      const ws = createMockWS()
      const comp = new CounterComponent({}, ws)
      await expect(comp.executeAction('executeAction', {})).rejects.toThrow('not callable')
    })

    it('should block lifecycle hooks', async () => {
      const ws = createMockWS()
      const comp = new CounterComponent({}, ws)

      for (const hook of ['onMount', 'onDestroy', 'onConnect', 'onDisconnect', 'onStateChange', 'onAction']) {
        await expect(comp.executeAction(hook, {})).rejects.toThrow('not callable')
      }
    })

    it('should block setState', async () => {
      const ws = createMockWS()
      const comp = new CounterComponent({}, ws)
      await expect(comp.executeAction('setState', { count: 999 })).rejects.toThrow('not callable')
    })

    it('should block setAuthContext', async () => {
      const ws = createMockWS()
      const comp = new CounterComponent({}, ws)
      await expect(comp.executeAction('setAuthContext', {})).rejects.toThrow('not callable')
    })

    it('should block _resetAuthContext', async () => {
      const ws = createMockWS()
      const comp = new CounterComponent({}, ws)
      await expect(comp.executeAction('_resetAuthContext', {})).rejects.toThrow('not callable')
    })

    it('should block $auth', async () => {
      const ws = createMockWS()
      const comp = new CounterComponent({}, ws)
      await expect(comp.executeAction('$auth', {})).rejects.toThrow('not callable')
    })

    it('should block $private', async () => {
      const ws = createMockWS()
      const comp = new CounterComponent({}, ws)
      await expect(comp.executeAction('$private', {})).rejects.toThrow('not callable')
    })

    it('should block emit', async () => {
      const ws = createMockWS()
      const comp = new CounterComponent({}, ws)
      await expect(comp.executeAction('emit', {})).rejects.toThrow('not callable')
    })
  })

  describe('Private methods (underscore prefix)', () => {
    it('should block methods starting with _', async () => {
      const ws = createMockWS()
      const comp = new CounterComponent({}, ws)
      await expect(comp.executeAction('_internalReset', {})).rejects.toThrow('not callable')
    })

    it('should block methods starting with #', async () => {
      const ws = createMockWS()
      const comp = new CounterComponent({}, ws)
      await expect(comp.executeAction('#secret', {})).rejects.toThrow('not callable')
    })
  })

  describe('publicActions enforcement', () => {
    it('should block methods not in publicActions', async () => {
      const ws = createMockWS()
      const comp = new CounterComponent({}, ws)
      await expect(comp.executeAction('secretMethod', {})).rejects.toThrow('not listed in publicActions')
    })

    it('should allow methods in publicActions', async () => {
      const ws = createMockWS()
      const comp = new CounterComponent({}, ws)
      const result = await comp.executeAction('increment', {})
      expect(result).toEqual({ count: 1 })
    })

    it('should block ALL actions when no publicActions defined', async () => {
      const ws = createMockWS()
      const comp = new NoPublicActionsComponent({}, ws)
      await expect(comp.executeAction('doSomething', {})).rejects.toThrow('no publicActions defined')
    })

    it('should block actions that do not exist on the component', async () => {
      const ws = createMockWS()
      const comp = new CounterComponent({}, ws)
      await expect(comp.executeAction('nonExistent', {})).rejects.toThrow('not callable')
    })
  })

  describe('Prototype pollution via action name', () => {
    it('should block toString (inherited from Object.prototype)', async () => {
      const ws = createMockWS()
      const comp = new CounterComponent({}, ws)
      // Blocked because it's inherited and not in publicActions
      await expect(comp.executeAction('toString', {})).rejects.toThrow()
    })

    it('should block hasOwnProperty (inherited from Object.prototype)', async () => {
      const ws = createMockWS()
      const comp = new CounterComponent({}, ws)
      await expect(comp.executeAction('hasOwnProperty', {})).rejects.toThrow()
    })

    it('should block __defineGetter__ (underscore prefix)', async () => {
      const ws = createMockWS()
      const comp = new CounterComponent({}, ws)
      await expect(comp.executeAction('__defineGetter__', {})).rejects.toThrow('not callable')
    })

    it('should block valueOf (inherited from Object.prototype)', async () => {
      const ws = createMockWS()
      const comp = new CounterComponent({}, ws)
      await expect(comp.executeAction('valueOf', {})).rejects.toThrow()
    })
  })

  describe('Auth context immutability', () => {
    it('should allow setting auth context once', () => {
      const ws = createMockWS()
      const comp = new CounterComponent({}, ws)
      const auth = { authenticated: true, user: { id: 'u1' } } as any
      comp.setAuthContext(auth)
      expect(comp.$auth).toBe(auth)
    })

    it('should throw on second setAuthContext call', () => {
      const ws = createMockWS()
      const comp = new CounterComponent({}, ws)
      const auth1 = { authenticated: true, user: { id: 'u1' } } as any
      const auth2 = { authenticated: true, user: { id: 'u2' } } as any
      comp.setAuthContext(auth1)
      expect(() => comp.setAuthContext(auth2)).toThrow('immutable')
    })

    it('should allow re-set after _resetAuthContext', () => {
      const ws = createMockWS()
      const comp = new CounterComponent({}, ws)
      const auth1 = { authenticated: true, user: { id: 'u1' } } as any
      comp.setAuthContext(auth1)
      comp._resetAuthContext()
      const auth2 = { authenticated: true, user: { id: 'u2' } } as any
      comp.setAuthContext(auth2)
      expect(comp.$auth).toBe(auth2)
    })
  })

  describe('Zod schema validation', () => {
    it('should accept valid payload', async () => {
      const ws = createMockWS()
      const comp = new ValidatedComponent({}, ws)
      const result = await comp.executeAction('sendMessage', { text: '  hello  ' })
      // Schema trims whitespace via result.data
      expect(result).toEqual({ sent: 'hello' })
    })

    it('should reject payload with missing required field', async () => {
      const ws = createMockWS()
      const comp = new ValidatedComponent({}, ws)
      await expect(comp.executeAction('sendMessage', {})).rejects.toThrow('validation failed')
    })

    it('should reject payload with wrong type', async () => {
      const ws = createMockWS()
      const comp = new ValidatedComponent({}, ws)
      await expect(comp.executeAction('sendMessage', { text: 123 })).rejects.toThrow('validation failed')
    })

    it('should reject payload that exceeds length', async () => {
      const ws = createMockWS()
      const comp = new ValidatedComponent({}, ws)
      await expect(comp.executeAction('sendMessage', { text: 'a'.repeat(101) })).rejects.toThrow('validation failed')
    })

    it('should reject non-object payload', async () => {
      const ws = createMockWS()
      const comp = new ValidatedComponent({}, ws)
      await expect(comp.executeAction('sendMessage', 'just a string')).rejects.toThrow('validation failed')
    })

    it('should allow actions without schema defined', async () => {
      const ws = createMockWS()
      const comp = new ValidatedComponent({}, ws)
      const result = await comp.executeAction('noSchemaAction', { anything: true })
      expect(result).toEqual({ received: { anything: true } })
    })
  })

  describe('Action rate limiting (global)', () => {
    it('should allow calls within limit', async () => {
      const ws = createMockWS()
      const comp = new RateLimitedComponent({}, ws)

      // 3 calls allowed
      for (let i = 0; i < 3; i++) {
        await expect(comp.executeAction('doAction', {})).resolves.toEqual({ ok: true })
      }
    })

    it('should reject calls exceeding limit', async () => {
      const ws = createMockWS()
      const comp = new RateLimitedComponent({}, ws)

      // 3 calls OK
      for (let i = 0; i < 3; i++) {
        await comp.executeAction('doAction', {})
      }

      // 4th call should fail
      await expect(comp.executeAction('doAction', {})).rejects.toThrow('rate limit exceeded')
    })

    it('should share global limit across different actions', async () => {
      const ws = createMockWS()
      const comp = new RateLimitedComponent({}, ws)

      // 2 calls to doAction
      await comp.executeAction('doAction', {})
      await comp.executeAction('doAction', {})
      // 1 call to otherAction
      await comp.executeAction('otherAction', {})

      // 4th total call should fail (global limit = 3)
      await expect(comp.executeAction('otherAction', {})).rejects.toThrow('rate limit exceeded')
    })
  })

  describe('Action rate limiting (per-action)', () => {
    it('should track limits independently per action', async () => {
      const ws = createMockWS()
      const comp = new PerActionRateLimitedComponent({}, ws)

      // 2 calls to actionA (at limit)
      await comp.executeAction('actionA', {})
      await comp.executeAction('actionA', {})

      // actionB should still work (separate counter)
      await expect(comp.executeAction('actionB', {})).resolves.toEqual({ action: 'B' })

      // 3rd call to actionA should fail
      await expect(comp.executeAction('actionA', {})).rejects.toThrow('rate limit exceeded')
    })
  })
})
