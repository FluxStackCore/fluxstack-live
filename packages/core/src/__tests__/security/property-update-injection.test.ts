// CVE-class regression: PROPERTY_UPDATE used to accept ANY property name
// from the client, allowing a malicious frame to inject arbitrary fields
// into a component's state (e.g. inject `session` so that subsequent
// `this.state.session.id` reads in action handlers pick up an attacker-
// controlled value).
//
// Fix in ComponentRegistry.updateProperty:
//   1. Whitelist keys via `static defaultState` OR `static updatableFields`.
//   2. Always reject prototype-pollution keys.
//   3. Always reject `$`-prefixed keys (server-only convention).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ComponentRegistry } from '../../component/ComponentRegistry'
import { LiveComponent } from '../../component/LiveComponent'
import { setLiveComponentContext } from '../../component/context'
import { StateSignatureManager } from '../../security/StateSignature'
import { LiveAuthManager } from '../../auth/LiveAuthManager'
import { RoomEventBus } from '../../rooms/RoomEventBus'
import { LiveRoomManager } from '../../rooms/LiveRoomManager'
import { createMockWS } from '../helpers'

vi.mock('../../transport/WsSendBatcher', () => ({
  queueWsMessage: vi.fn(),
  queuePreSerialized: vi.fn(),
  sendImmediate: vi.fn(),
  setResyncHandler: vi.fn(),
  sendBinaryImmediate: vi.fn(),
}))
vi.mock('../../debug/LiveLogger', () => ({
  liveLog: vi.fn(),
  liveWarn: vi.fn(),
  registerComponentLogging: vi.fn(),
  unregisterComponentLogging: vi.fn(),
}))

class Counter extends LiveComponent<{ count: number; label: string }> {
  static componentName = 'Counter'
  static defaultState = { count: 0, label: 'hits' }
  static publicActions = ['bump'] as const
  bump() { this.setState({ count: (this.state as any).count + 1 }) }
}

class CounterWithAllowlist extends LiveComponent<{ count: number; label: string; secret: string }> {
  static componentName = 'CounterWithAllowlist'
  static defaultState = { count: 0, label: 'hits', secret: 'safe' }
  // Only `count` is writable by the client — `secret` and `label` are not.
  static updatableFields = ['count'] as const
  static publicActions = [] as const
}

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

  return new ComponentRegistry({
    authManager,
    stateSignature,
    performanceMonitor: performanceMonitor as any,
  } as any)
}

let errSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => { errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { errSpy.mockRestore(); vi.clearAllMocks() })

describe('PROPERTY_UPDATE — injection defense', () => {
  it('allows updating a key declared in defaultState', async () => {
    const registry = createTestRegistry()
    registry.registerComponentClass('Counter', Counter as any)
    const ws = createMockWS()
    const { componentId } = await registry.mountComponent(ws, 'Counter')

    expect(() => registry.updateProperty(componentId, 'count', 99)).not.toThrow()
    const comp = (registry as any).components.get(componentId)
    expect((comp.state as any).count).toBe(99)
  })

  it('REJECTS injection of an unknown field (the issue)', async () => {
    const registry = createTestRegistry()
    registry.registerComponentClass('Counter', Counter as any)
    const ws = createMockWS()
    const { componentId } = await registry.mountComponent(ws, 'Counter')

    // 🎯 Attack: try to inject `session` (would otherwise pollute state.session.id).
    expect(() =>
      registry.updateProperty(componentId, 'session', { id: 'admin-1', roles: ['admin'] }),
    ).toThrow(/not an updatable field/)
    const comp = (registry as any).components.get(componentId)
    expect((comp.state as any).session).toBeUndefined()
  })

  it('REJECTS prototype-pollution keys (__proto__, constructor, prototype)', async () => {
    const registry = createTestRegistry()
    registry.registerComponentClass('Counter', Counter as any)
    const ws = createMockWS()
    const { componentId } = await registry.mountComponent(ws, 'Counter')

    expect(() => registry.updateProperty(componentId, '__proto__', { polluted: true })).toThrow(/reserved key/)
    expect(() => registry.updateProperty(componentId, 'constructor', {} as any)).toThrow(/reserved key/)
    expect(() => registry.updateProperty(componentId, 'prototype', {} as any)).toThrow(/reserved key/)

    expect((({} as any).polluted)).toBeUndefined()
  })

  it('REJECTS $-prefixed keys (server-only convention)', async () => {
    const registry = createTestRegistry()
    registry.registerComponentClass('Counter', Counter as any)
    const ws = createMockWS()
    const { componentId } = await registry.mountComponent(ws, 'Counter')

    expect(() => registry.updateProperty(componentId, '$auth', { roles: ['admin'] })).toThrow(/server-only/)
    expect(() => registry.updateProperty(componentId, '$private', { secret: 'x' })).toThrow(/server-only/)
    expect(() => registry.updateProperty(componentId, '$anyCustom', 'x')).toThrow(/server-only/)
  })

  it('updatableFields allowlist OVERRIDES defaultState (stricter)', async () => {
    const registry = createTestRegistry()
    registry.registerComponentClass('CounterWithAllowlist', CounterWithAllowlist as any)
    const ws = createMockWS()
    const { componentId } = await registry.mountComponent(ws, 'CounterWithAllowlist')

    expect(() => registry.updateProperty(componentId, 'count', 5)).not.toThrow()
    expect(() => registry.updateProperty(componentId, 'secret', 'leaked')).toThrow(/not an updatable field/)
    expect(() => registry.updateProperty(componentId, 'label', 'changed')).toThrow(/not an updatable field/)

    const comp = (registry as any).components.get(componentId)
    expect((comp.state as any).secret).toBe('safe')
    expect((comp.state as any).label).toBe('hits')
  })

  it('rejection error message lists the allowed fields (helpful for devs)', async () => {
    const registry = createTestRegistry()
    registry.registerComponentClass('Counter', Counter as any)
    const ws = createMockWS()
    const { componentId } = await registry.mountComponent(ws, 'Counter')

    try {
      registry.updateProperty(componentId, 'nope', 1)
      throw new Error('should have thrown')
    } catch (err: any) {
      expect(err.message).toContain('count')
      expect(err.message).toContain('label')
      expect(err.message).toContain('updatableFields')
    }
  })

  it('server-side this.setState({$x: ...}) is unaffected — bypasses updateProperty', async () => {
    // The $-prefix rule applies ONLY to the client-driven PROPERTY_UPDATE
    // path. The server has full authority to mutate any field via setState.
    const registry = createTestRegistry()
    class WithDollar extends LiveComponent<{ count: number; $serverOnly: string }> {
      static componentName = 'WithDollar'
      static defaultState = { count: 0, $serverOnly: 'init' }
      static publicActions = ['serverWrite'] as const
      serverWrite() { this.setState({ $serverOnly: 'updated-by-server' } as any) }
    }
    registry.registerComponentClass('WithDollar', WithDollar as any)
    const ws = createMockWS()
    const { componentId } = await registry.mountComponent(ws, 'WithDollar')

    // Client cannot write $serverOnly:
    expect(() => registry.updateProperty(componentId, '$serverOnly', 'hacked')).toThrow(/server-only/)

    // But the server-side action freely updates it via this.setState:
    const comp = (registry as any).components.get(componentId)
    comp.serverWrite()
    expect((comp.state as any).$serverOnly).toBe('updated-by-server')
  })
})
