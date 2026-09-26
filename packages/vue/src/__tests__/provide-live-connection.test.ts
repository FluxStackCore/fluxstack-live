// provideLiveConnection / useLiveConnection: o estado reativo do Vue deve
// espelhar o LiveConnection (connected, connecting, connectionId, error,
// transport, authenticated) e o unmount deve liberar tudo.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { defineComponent, isReadonly } from 'vue'
import { useLiveConnection } from '../index'
import { mountWithLive, fakeTransportFactory, flush, createHeadlessApp, newHostNode, type Mounted } from './harness'

let mounted: Mounted<unknown> | null = null
afterEach(() => {
  mounted?.unmount()
  mounted = null
})

describe('provideLiveConnection', () => {
  it('conecta automaticamente e espelha o estado do LiveConnection', () => {
    const t = fakeTransportFactory()
    mounted = mountWithLive({ transport: t.factory, heartbeatInterval: 60_000 }, () => useLiveConnection())
    const { ctx } = mounted

    expect(t.created).toHaveLength(1)
    expect(ctx.connecting.value).toBe(true)
    expect(ctx.connected.value).toBe(false)
    expect(ctx.transport.value).toBeNull()

    t.current().accept()
    expect(ctx.connected.value).toBe(true)
    expect(ctx.connecting.value).toBe(false)
    expect(ctx.transport.value).toBe('fake')

    t.current().serverSend({ type: 'CONNECTION_ESTABLISHED', connectionId: 'conn-1', authenticated: true })
    expect(ctx.connectionId.value).toBe('conn-1')
    expect(ctx.authenticated.value).toBe(true)
  })

  it('o filho recebe o MESMO contexto via useLiveConnection()', () => {
    const t = fakeTransportFactory()
    mounted = mountWithLive({ transport: t.factory }, () => useLiveConnection())
    expect(mounted.child).toBe(mounted.ctx)
  })

  it('expõe refs somente-leitura', () => {
    const t = fakeTransportFactory()
    mounted = mountWithLive({ transport: t.factory }, () => null)
    const { ctx } = mounted
    for (const r of [ctx.connected, ctx.connecting, ctx.error, ctx.connectionId, ctx.authenticated, ctx.transport]) {
      expect(isReadonly(r)).toBe(true)
    }
  })

  it('erro de transporte aparece em error; queda zera connectionId', () => {
    const t = fakeTransportFactory()
    mounted = mountWithLive({ transport: t.factory, reconnectInterval: 60_000 }, () => null)
    const { ctx } = mounted
    t.current().accept()
    t.current().serverSend({ type: 'CONNECTION_ESTABLISHED', connectionId: 'c1' })

    t.current().fail()
    expect(ctx.error.value).toBe('fake connection error')

    t.current().drop()
    expect(ctx.connected.value).toBe(false)
    expect(ctx.connectionId.value).toBeNull()
    expect(ctx.authenticated.value).toBe(false)
  })

  it('autoConnect: false não abre transporte até connection.connect()', () => {
    const t = fakeTransportFactory()
    mounted = mountWithLive({ transport: t.factory, autoConnect: false }, () => null)
    const { ctx } = mounted
    expect(t.created).toHaveLength(0)
    expect(ctx.connecting.value).toBe(false)

    ctx.connection.connect()
    expect(t.created).toHaveLength(1)
    t.current().accept()
    expect(ctx.connected.value).toBe(true)
  })

  it('reconecta sozinho após queda (FP-4: LiveConnection com retry infinito)', async () => {
    const t = fakeTransportFactory()
    mounted = mountWithLive({ transport: t.factory, reconnectInterval: 5 }, () => null)
    const { ctx } = mounted

    // várias quedas seguidas: não desiste (maxReconnectAttempts = Infinity por padrão)
    for (let i = 0; i < 7; i++) {
      t.current().drop()
      expect(ctx.connected.value).toBe(false)
      const before = t.created.length
      await vi.waitFor(() => expect(t.created.length).toBe(before + 1), { timeout: 2000 })
    }
    t.current().accept()
    expect(ctx.connected.value).toBe(true)
    expect(ctx.error.value).toBeNull()
  })

  it('reconnect() manual derruba e abre um transporte novo', async () => {
    const t = fakeTransportFactory()
    mounted = mountWithLive({ transport: t.factory }, () => null)
    const { ctx } = mounted
    t.current().accept()
    const first = t.current()

    ctx.reconnect()
    expect(first.closed).toBe(true)
    expect(ctx.connected.value).toBe(false)
    await vi.waitFor(() => expect(t.created).toHaveLength(2))
    t.current().accept()
    expect(ctx.connected.value).toBe(true)
  })

  it('authenticate() envia AUTH e atualiza authenticated', async () => {
    const t = fakeTransportFactory()
    mounted = mountWithLive({ transport: t.factory }, () => null)
    const { ctx } = mounted
    t.current().accept()

    const p = ctx.authenticate({ token: 'abc' })
    const auth = t.current().lastSent('AUTH')!
    expect(auth.payload).toEqual({ token: 'abc' })
    t.current().serverSend({
      type: 'AUTH_RESPONSE',
      requestId: auth.requestId,
      success: true,
      payload: { authenticated: true, session: { id: 'u1' } },
    })
    await expect(p).resolves.toBe(true)
    expect(ctx.authenticated.value).toBe(true)
  })

  it('unmount destrói a conexão: fecha o transporte, para listeners e não reconecta', async () => {
    const t = fakeTransportFactory()
    mounted = mountWithLive({ transport: t.factory, reconnectInterval: 5 }, () => null)
    const { ctx } = mounted
    t.current().accept()
    expect(ctx.connected.value).toBe(true)

    mounted.unmount()
    expect(t.current().closed).toBe(true)
    await new Promise((r) => setTimeout(r, 50))
    expect(t.created).toHaveLength(1) // nenhuma reconexão depois do destroy

    // listener removido: mexer na conexão não altera mais os refs
    ctx.connection.connect()
    await flush()
    expect(ctx.connecting.value).toBe(false)
  })

  it('useLiveConnection() sem provider lança erro claro', () => {
    const Orphan = defineComponent({
      setup() {
        useLiveConnection()
        return () => null
      },
    })
    const app = createHeadlessApp(Orphan)
    let caught: unknown
    app.config.errorHandler = (err) => { caught = err }
    app.config.warnHandler = () => {}
    try { app.mount(newHostNode()) } catch (e) { caught ??= e }
    expect(String(caught)).toMatch(/requires provideLiveConnection/)
  })
})
