// Test helpers for @fluxstack/live core tests
//
// Minimal mocks and factories for WebSocket, auth contexts, and components.

import type { GenericWebSocket, LiveWSData } from '../transport/types'
import type { LiveAuthProvider } from '../auth/types'
import { ANONYMOUS_CONTEXT, AuthenticatedContext } from '../auth/LiveAuthContext'

// ===== WebSocket Mock =====

export function createMockWS(overrides?: Partial<LiveWSData>): GenericWebSocket & { _messages: string[] } {
  const messages: string[] = []
  const data: LiveWSData = {
    connectionId: `ws-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    components: new Map(),
    subscriptions: new Set(),
    connectedAt: new Date(),
    userId: undefined,
    authContext: ANONYMOUS_CONTEXT,
    ...overrides,
  }

  return {
    send: (msg: string | ArrayBuffer | Uint8Array) => {
      messages.push(typeof msg === 'string' ? msg : msg.toString())
    },
    close: () => {},
    data,
    remoteAddress: '127.0.0.1',
    readyState: 1 as const,
    _messages: messages,
  } as GenericWebSocket & { _messages: string[] }
}

// ===== Auth Helpers =====

export function createAuthenticatedWS(
  user: { id: string; roles?: string[]; permissions?: string[] },
  token = 'test-token',
): GenericWebSocket & { _messages: string[] } {
  const authContext = new AuthenticatedContext(user, token)
  return createMockWS({ authContext })
}

export function createSuccessProvider(
  name: string,
  user: { id: string; roles?: string[]; permissions?: string[] },
): LiveAuthProvider {
  return {
    name,
    async authenticate() {
      return new AuthenticatedContext(user)
    },
  }
}

export function createFailingProvider(name: string, error: Error): LiveAuthProvider {
  return {
    name,
    async authenticate() {
      throw error
    },
  }
}

export function createReturnsNullProvider(name: string): LiveAuthProvider {
  return {
    name,
    async authenticate() {
      return null
    },
  }
}

// ===== Console Spy =====

export function spyOnConsole() {
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  }

  const calls = {
    log: [] as any[][],
    warn: [] as any[][],
    error: [] as any[][],
  }

  console.log = (...args: any[]) => { calls.log.push(args) }
  console.warn = (...args: any[]) => { calls.warn.push(args) }
  console.error = (...args: any[]) => { calls.error.push(args) }

  return {
    calls,
    restore() {
      console.log = original.log
      console.warn = original.warn
      console.error = original.error
    },
  }
}
