// Tests for custom session typing in auth
//
// Validates that devs can put any data in LiveAuthSession
// and access it via this.$auth.session in components.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ComponentRegistry } from '../../component/ComponentRegistry'
import { LiveComponent } from '../../component/LiveComponent'
import { setLiveComponentContext } from '../../component/context'
import { StateSignatureManager } from '../../security/StateSignature'
import { LiveAuthManager } from '../../auth/LiveAuthManager'
import { AuthenticatedContext } from '../../auth/LiveAuthContext'
import { RoomEventBus } from '../../rooms/RoomEventBus'
import { LiveRoomManager } from '../../rooms/LiveRoomManager'
import { createMockWS, spyOnConsole } from '../helpers'
import type { LiveAuthProvider, LiveAuthCredentials, LiveAuthContext } from '../../auth/types'

// ===== Custom session shapes =====

// User session (traditional)
interface UserSession {
  id: string
  name: string
  email: string
  avatar: string
  plan: 'free' | 'pro' | 'enterprise'
  roles: string[]
  permissions: string[]
}

// Bot/service session
interface BotSession {
  id: string
  type: 'bot'
  botName: string
  ownerId: string
  allowedChannels: string[]
  roles: string[]
}

// Device session (IoT)
interface DeviceSession {
  id: string
  type: 'device'
  model: string
  firmwareVersion: string
  location: { lat: number; lng: number }
  roles: string[]
}

// ===== Custom providers =====

class UserAuthProvider implements LiveAuthProvider {
  readonly name = 'user'

  async authenticate(credentials: LiveAuthCredentials): Promise<LiveAuthContext | null> {
    if (credentials.token === 'user-pro') {
      return new AuthenticatedContext({
        id: 'user-1',
        name: 'João',
        email: 'joao@test.com',
        avatar: 'https://avatar.test/joao.png',
        plan: 'pro',
        roles: ['user', 'pro'],
        permissions: ['chat.write', 'files.upload'],
      } satisfies UserSession)
    }
    if (credentials.token === 'user-free') {
      return new AuthenticatedContext({
        id: 'user-2',
        name: 'Maria',
        email: 'maria@test.com',
        avatar: 'https://avatar.test/maria.png',
        plan: 'free',
        roles: ['user'],
        permissions: ['chat.write'],
      } satisfies UserSession)
    }
    return null
  }
}

class BotAuthProvider implements LiveAuthProvider {
  readonly name = 'bot'

  async authenticate(credentials: LiveAuthCredentials): Promise<LiveAuthContext | null> {
    if (credentials.token === 'bot-token') {
      return new AuthenticatedContext({
        id: 'bot-1',
        type: 'bot',
        botName: 'NotifyBot',
        ownerId: 'user-1',
        allowedChannels: ['general', 'alerts'],
        roles: ['bot'],
      } satisfies BotSession)
    }
    return null
  }
}

class DeviceAuthProvider implements LiveAuthProvider {
  readonly name = 'device'

  async authenticate(credentials: LiveAuthCredentials): Promise<LiveAuthContext | null> {
    if (credentials.token === 'device-token') {
      return new AuthenticatedContext({
        id: 'sensor-42',
        type: 'device',
        model: 'TempSensor-v3',
        firmwareVersion: '2.1.0',
        location: { lat: -23.5, lng: -46.6 },
        roles: ['device', 'sensor'],
      } satisfies DeviceSession)
    }
    return null
  }
}

// ===== Test components =====

class ProOnlyComponent extends LiveComponent<{ data: string }> {
  static componentName = 'ProOnly'
  static defaultState = { data: '' }
  static publicActions = ['getData'] as const
  static auth = {
    required: true,
    authorize: (auth: LiveAuthContext) => {
      const plan = (auth.session as any)?.plan
      if (plan !== 'pro' && plan !== 'enterprise') {
        return { allowed: false, reason: 'Pro or Enterprise plan required' }
      }
      return true
    },
  }

  getData() {
    const session = this.$auth.session as unknown as UserSession
    return {
      name: session.name,
      plan: session.plan,
      avatar: session.avatar,
    }
  }
}

class BotComponent extends LiveComponent<{ lastMessage: string }> {
  static componentName = 'BotDashboard'
  static defaultState = { lastMessage: '' }
  static publicActions = ['sendNotification'] as const
  static auth = {
    required: true,
    authorize: (auth: LiveAuthContext) => {
      return (auth.session as any)?.type === 'bot'
    },
  }

  sendNotification(payload: { channel: string; message: string }) {
    const session = this.$auth.session as unknown as BotSession
    if (!session.allowedChannels.includes(payload.channel)) {
      throw new Error(`Bot not allowed in channel: ${payload.channel}`)
    }
    this.setState({ lastMessage: payload.message })
    return { sent: true, botName: session.botName, channel: payload.channel }
  }
}

class DeviceComponent extends LiveComponent<{ readings: number[] }> {
  static componentName = 'DeviceMonitor'
  static defaultState = { readings: [] }
  static publicActions = ['addReading', 'getInfo'] as const
  static auth = {
    required: true,
    authorize: (auth: LiveAuthContext) => {
      return (auth.session as any)?.type === 'device'
    },
  }

  addReading(payload: { value: number }) {
    this.state.readings = [...this.state.readings, payload.value]
    return { count: this.state.readings.length }
  }

  getInfo() {
    const session = this.$auth.session as unknown as DeviceSession
    return {
      model: session.model,
      firmware: session.firmwareVersion,
      location: session.location,
    }
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

function createWsWithAuth(authManager: LiveAuthManager, token: string) {
  // Simulate the auth flow: authenticate then create ws with context
  return authManager.authenticate({ token }).then(authContext => {
    const ws = createMockWS({ authContext })
    return ws
  })
}

// ===== Tests =====

describe('Custom session typing', () => {
  let consoleSpy: ReturnType<typeof spyOnConsole>

  beforeEach(() => { consoleSpy = spyOnConsole() })
  afterEach(() => { consoleSpy.restore() })

  describe('User session (traditional)', () => {
    it('should authenticate with custom user fields', async () => {
      const { authManager } = createTestRegistry()
      authManager.register(new UserAuthProvider())

      const ctx = await authManager.authenticate({ token: 'user-pro' })
      expect(ctx.authenticated).toBe(true)
      expect(ctx.session?.id).toBe('user-1')
      expect((ctx.session as any).name).toBe('João')
      expect((ctx.session as any).plan).toBe('pro')
      expect((ctx.session as any).avatar).toBe('https://avatar.test/joao.png')
    })

    it('should allow pro user to mount ProOnly component', async () => {
      const { registry, authManager } = createTestRegistry()
      authManager.register(new UserAuthProvider())
      registry.registerComponentClass('ProOnly', ProOnlyComponent as any)

      const ws = await createWsWithAuth(authManager, 'user-pro')
      const result = await registry.mountComponent(ws, 'ProOnly')
      expect(result.componentId).toBeDefined()
    })

    it('should deny free user from ProOnly component', async () => {
      const { registry, authManager } = createTestRegistry()
      authManager.register(new UserAuthProvider())
      registry.registerComponentClass('ProOnly', ProOnlyComponent as any)

      const ws = await createWsWithAuth(authManager, 'user-free')
      await expect(registry.mountComponent(ws, 'ProOnly')).rejects.toThrow('Pro or Enterprise plan required')
    })

    it('should access custom session fields in actions', async () => {
      const { registry, authManager } = createTestRegistry()
      authManager.register(new UserAuthProvider())
      registry.registerComponentClass('ProOnly', ProOnlyComponent as any)

      const ws = await createWsWithAuth(authManager, 'user-pro')
      const { componentId } = await registry.mountComponent(ws, 'ProOnly')
      const result = await registry.executeAction(componentId, 'getData', {})

      expect(result).toEqual({
        name: 'João',
        plan: 'pro',
        avatar: 'https://avatar.test/joao.png',
      })
    })
  })

  describe('Bot session', () => {
    it('should authenticate bot with custom fields', async () => {
      const { authManager } = createTestRegistry()
      authManager.register(new BotAuthProvider())

      const ctx = await authManager.authenticate({ token: 'bot-token' })
      expect(ctx.authenticated).toBe(true)
      expect(ctx.session?.id).toBe('bot-1')
      expect((ctx.session as any).type).toBe('bot')
      expect((ctx.session as any).botName).toBe('NotifyBot')
      expect((ctx.session as any).allowedChannels).toEqual(['general', 'alerts'])
    })

    it('should allow bot to mount BotDashboard', async () => {
      const { registry, authManager } = createTestRegistry()
      authManager.register(new BotAuthProvider())
      registry.registerComponentClass('BotDashboard', BotComponent as any)

      const ws = await createWsWithAuth(authManager, 'bot-token')
      const result = await registry.mountComponent(ws, 'BotDashboard')
      expect(result.componentId).toBeDefined()
    })

    it('should deny user from mounting BotDashboard', async () => {
      const { registry, authManager } = createTestRegistry()
      authManager.register(new UserAuthProvider())
      registry.registerComponentClass('BotDashboard', BotComponent as any)

      const ws = await createWsWithAuth(authManager, 'user-pro')
      await expect(registry.mountComponent(ws, 'BotDashboard')).rejects.toThrow('AUTH_DENIED')
    })

    it('should enforce allowedChannels in action', async () => {
      const { registry, authManager } = createTestRegistry()
      authManager.register(new BotAuthProvider())
      registry.registerComponentClass('BotDashboard', BotComponent as any)

      const ws = await createWsWithAuth(authManager, 'bot-token')
      const { componentId } = await registry.mountComponent(ws, 'BotDashboard')

      // Allowed channel
      const ok = await registry.executeAction(componentId, 'sendNotification', {
        channel: 'general', message: 'Hello',
      })
      expect(ok).toEqual({ sent: true, botName: 'NotifyBot', channel: 'general' })

      // Blocked channel
      await expect(
        registry.executeAction(componentId, 'sendNotification', {
          channel: 'secret', message: 'Hack',
        })
      ).rejects.toThrow('Bot not allowed in channel: secret')
    })
  })

  describe('Device/IoT session', () => {
    it('should authenticate device with location data', async () => {
      const { authManager } = createTestRegistry()
      authManager.register(new DeviceAuthProvider())

      const ctx = await authManager.authenticate({ token: 'device-token' })
      expect(ctx.authenticated).toBe(true)
      expect(ctx.session?.id).toBe('sensor-42')
      expect((ctx.session as any).model).toBe('TempSensor-v3')
      expect((ctx.session as any).location).toEqual({ lat: -23.5, lng: -46.6 })
    })

    it('should mount DeviceMonitor and access device info', async () => {
      const { registry, authManager } = createTestRegistry()
      authManager.register(new DeviceAuthProvider())
      registry.registerComponentClass('DeviceMonitor', DeviceComponent as any)

      const ws = await createWsWithAuth(authManager, 'device-token')
      const { componentId } = await registry.mountComponent(ws, 'DeviceMonitor')

      const info = await registry.executeAction(componentId, 'getInfo', {})
      expect(info).toEqual({
        model: 'TempSensor-v3',
        firmware: '2.1.0',
        location: { lat: -23.5, lng: -46.6 },
      })
    })

    it('should deny user from mounting DeviceMonitor', async () => {
      const { registry, authManager } = createTestRegistry()
      authManager.register(new UserAuthProvider())
      registry.registerComponentClass('DeviceMonitor', DeviceComponent as any)

      const ws = await createWsWithAuth(authManager, 'user-pro')
      await expect(registry.mountComponent(ws, 'DeviceMonitor')).rejects.toThrow('AUTH_DENIED')
    })
  })

  describe('Multiple providers', () => {
    it('should handle multiple providers with different session shapes', async () => {
      const { registry, authManager } = createTestRegistry()
      authManager.register(new UserAuthProvider())
      authManager.register(new BotAuthProvider())
      authManager.register(new DeviceAuthProvider())

      registry.registerComponentClass('ProOnly', ProOnlyComponent as any)
      registry.registerComponentClass('BotDashboard', BotComponent as any)
      registry.registerComponentClass('DeviceMonitor', DeviceComponent as any)

      // User can mount ProOnly
      const wsUser = await createWsWithAuth(authManager, 'user-pro')
      const r1 = await registry.mountComponent(wsUser, 'ProOnly')
      expect(r1.componentId).toBeDefined()

      // Bot can mount BotDashboard
      const wsBot = await createWsWithAuth(authManager, 'bot-token')
      const r2 = await registry.mountComponent(wsBot, 'BotDashboard')
      expect(r2.componentId).toBeDefined()

      // Device can mount DeviceMonitor
      const wsDevice = await createWsWithAuth(authManager, 'device-token')
      const r3 = await registry.mountComponent(wsDevice, 'DeviceMonitor')
      expect(r3.componentId).toBeDefined()

      // Cross-access denied
      await expect(registry.mountComponent(wsUser, 'BotDashboard')).rejects.toThrow('AUTH_DENIED')
      await expect(registry.mountComponent(wsBot, 'DeviceMonitor')).rejects.toThrow('AUTH_DENIED')
      await expect(registry.mountComponent(wsDevice, 'ProOnly')).rejects.toThrow('AUTH_DENIED')
    })
  })

  describe('Backward compatibility (user alias)', () => {
    it('should still work with $auth.user (deprecated)', async () => {
      const { authManager } = createTestRegistry()
      authManager.register(new UserAuthProvider())

      const ctx = await authManager.authenticate({ token: 'user-pro' })

      // New way
      expect(ctx.session?.id).toBe('user-1')
      // Deprecated way still works
      expect(ctx.user?.id).toBe('user-1')
      // Same reference
      expect(ctx.session).toBe(ctx.user)
    })
  })
})
