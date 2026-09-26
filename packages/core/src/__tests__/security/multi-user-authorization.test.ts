// Testes multiusuário de autorização (auditoria 2026-09-26).
//
// Cobrem três falhas estruturais encontradas:
//  1. Uma conexão executava actions / PROPERTY_UPDATE em componente de OUTRA conexão
//     (bastava conhecer o componentId, que vaza via broadcast de sala).
//  2. `actionAuth` era avaliado com o `$auth` do componente — num singleton, o de
//     quem montou primeiro — então todo cliente herdava as permissões dele.
//  3. `userId` vinha do cliente (message.userId) e virava `component.userId`.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ComponentRegistry } from '../../component/ComponentRegistry'
import { LiveComponent } from '../../component/LiveComponent'
import { StateSignatureManager } from '../../security/StateSignature'
import { LiveAuthManager } from '../../auth/LiveAuthManager'
import { createMockWS, createAuthenticatedWS } from '../helpers'
import type { ActionCaller } from '../../component/managers/ActionSecurityManager'

class Notes extends LiveComponent<{ text: string; count: number }> {
  static componentName = 'Notes'
  static defaultState = { text: '', count: 0 }
  static publicActions = ['bump', 'whoami'] as const

  bump() { this.state.count++; return this.state.count }
  whoami(_p: unknown, caller?: ActionCaller) {
    return { componentUser: this.$auth.session?.id ?? null, caller: caller?.auth.session?.id ?? null }
  }
}

class AdminBoard extends LiveComponent<{ items: string[] }> {
  static componentName = 'AdminBoard'
  static singleton = true
  static defaultState = { items: [] as string[] }
  static publicActions = ['wipe', 'read'] as const
  static actionAuth = { wipe: { roles: ['admin'] } }

  wipe() { this.state.items = []; return 'wiped' }
  read() { return this.state.items }
}

function createRegistry() {
  const registry = new ComponentRegistry({
    authManager: new LiveAuthManager(),
    stateSignature: new StateSignatureManager({ secret: 'test-secret-32chars-minimum-ok!' }),
    performanceMonitor: {
      initializeComponent: () => {},
      recordRenderTime: () => {},
      recordActionTime: () => {},
      removeComponent: () => {},
    } as any,
  })
  registry.registerComponentClass('Notes', Notes as any)
  registry.registerComponentClass('AdminBoard', AdminBoard as any)
  return registry
}

describe('Autorização multiusuário', () => {
  let registry: ComponentRegistry
  beforeEach(() => { registry = createRegistry() })
  afterEach(() => { registry.cleanup() })

  async function mount(ws: any, component: string, extra: Record<string, unknown> = {}) {
    const res = await registry.handleMessage(ws, {
      type: 'COMPONENT_MOUNT',
      componentId: '',
      payload: { component, props: {} },
      ...extra,
    } as any)
    expect(res?.success).toBe(true)
    return (res!.result as any).componentId as string
  }

  describe('posse do componente', () => {
    it('conexão B NÃO executa action no componente da conexão A', async () => {
      const a = createMockWS()
      const b = createMockWS()
      const id = await mount(a, 'Notes')

      const res = await registry.handleMessage(b, {
        type: 'CALL_ACTION', componentId: id, action: 'bump', payload: {}, expectResponse: true,
      } as any)

      expect(res?.success).toBe(false)
      expect(res?.error).toContain('COMPONENT_REHYDRATION_REQUIRED')
      expect((registry.getComponent(id) as any).state.count).toBe(0)
    })

    it('conexão B NÃO faz PROPERTY_UPDATE no componente da conexão A', async () => {
      const a = createMockWS()
      const b = createMockWS()
      const id = await mount(a, 'Notes')

      const res = await registry.handleMessage(b, {
        type: 'PROPERTY_UPDATE', componentId: id, property: 'text', payload: { value: 'hackeado' },
      } as any)

      expect(res?.success).toBe(false)
      expect((registry.getComponent(id) as any).state.text).toBe('')
    })

    it('o dono continua podendo executar normalmente', async () => {
      const a = createMockWS()
      const id = await mount(a, 'Notes')
      const res = await registry.handleMessage(a, {
        type: 'CALL_ACTION', componentId: id, action: 'bump', payload: {}, expectResponse: true,
      } as any)
      expect(res).toEqual({ success: true, result: 1 })
    })

    it('todo cliente que entrou no singleton pode chamar actions dele', async () => {
      const admin = createAuthenticatedWS({ id: 'u-admin', roles: ['admin'] })
      const guest = createMockWS()
      const id = await mount(admin, 'AdminBoard')
      const sameId = await mount(guest, 'AdminBoard')
      expect(sameId).toBe(id)

      const res = await registry.handleMessage(guest, {
        type: 'CALL_ACTION', componentId: id, action: 'read', payload: {}, expectResponse: true,
      } as any)
      expect(res?.success).toBe(true)
    })
  })

  describe('actionAuth usa a identidade de quem chama', () => {
    it('singleton montado por admin: convidado NÃO herda a role admin', async () => {
      const admin = createAuthenticatedWS({ id: 'u-admin', roles: ['admin'] })
      const guest = createMockWS()
      const id = await mount(admin, 'AdminBoard')
      await mount(guest, 'AdminBoard')

      const res = await registry.handleMessage(guest, {
        type: 'CALL_ACTION', componentId: id, action: 'wipe', payload: {}, expectResponse: true,
      } as any)
      expect(res?.success).toBe(false)
      expect(res?.error).toContain('AUTH_DENIED')
    })

    it('singleton montado por convidado: admin que entra depois consegue', async () => {
      const guest = createMockWS()
      const admin = createAuthenticatedWS({ id: 'u-admin', roles: ['admin'] })
      const id = await mount(guest, 'AdminBoard')
      await mount(admin, 'AdminBoard')

      const res = await registry.handleMessage(admin, {
        type: 'CALL_ACTION', componentId: id, action: 'wipe', payload: {}, expectResponse: true,
      } as any)
      expect(res).toEqual({ success: true, result: 'wiped' })
    })

    it('a action recebe o chamador como 2º argumento', async () => {
      const alice = createAuthenticatedWS({ id: 'alice' })
      const id = await mount(alice, 'Notes')
      const res = await registry.handleMessage(alice, {
        type: 'CALL_ACTION', componentId: id, action: 'whoami', payload: {}, expectResponse: true,
      } as any)
      expect(res?.result).toEqual({ componentUser: 'alice', caller: 'alice' })
    })
  })

  describe('userId nunca vem do cliente', () => {
    it('message.userId enviado pelo cliente é ignorado no mount', async () => {
      const anon = createMockWS()
      const id = await mount(anon, 'Notes', { userId: 'vitima' })
      expect(registry.getComponent(id)?.userId).toBeUndefined()
    })

    it('usuário autenticado recebe o userId da sessão, não o enviado', async () => {
      const bob = createAuthenticatedWS({ id: 'bob' })
      const id = await mount(bob, 'Notes', { userId: 'alice' })
      expect(registry.getComponent(id)?.userId).toBe('bob')
    })
  })
})

describe('rehydrate de singleton (auditoria 2026-09-26)', () => {
  it('re-hidratar um singleton volta para a instância compartilhada, não cria uma privada', async () => {
    const registry = createRegistry()
    try {
      const a = createMockWS()
      const mountA = await registry.mountComponent(a, 'AdminBoard')
      const signed = mountA.signedState as Parameters<typeof registry.rehydrateComponent>[2]

      // B reconecta com o estado assinado que tinha guardado
      const b = createMockWS()
      const res = await registry.rehydrateComponent(mountA.componentId, 'AdminBoard', signed, b)

      expect(res.success).toBe(true)
      expect(res.newComponentId).toBe(mountA.componentId)
      expect(registry.getStats().singletons['AdminBoard'].connections).toBe(2)
    } finally {
      registry.cleanup()
    }
  })
})
