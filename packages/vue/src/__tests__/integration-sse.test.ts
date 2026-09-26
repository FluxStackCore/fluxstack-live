// Integração ponta a ponta do @fluxstack/live-vue:
//   LiveServer real (sse)  ⇄  provideLiveConnection + useLive (transporte SSE)
// ligados por um `fetch` em memória (mesmo esquema de
// __tests__/integration/sse-transport.test.ts). Nenhuma porta é aberta.
import { describe, it, expect, afterEach } from 'vitest'
import { LiveServer, LiveComponent } from '@fluxstack/live'
import type { LiveTransport, RawHttpRoute, WebSocketConfig } from '@fluxstack/live'
import { SseClientTransport } from '@fluxstack/live-client'
import { useLive, type UseLiveComponentOptions, type UseLiveComponentReturn } from '../index'
import { mountWithLive, until, type Mounted } from './harness'

interface BoardState {
  count: number
  owner: string | null
  tags: Record<string, number>
}

class VueBoard extends LiveComponent<BoardState> {
  static componentName = 'VueBoard'
  static defaultState: BoardState = { count: 0, owner: 'server', tags: {} }
  static publicActions = ['increment', 'tag', 'untag', 'clearOwner', 'fail'] as const

  increment(payload: { by?: number } = {}) {
    this.state.count += payload.by ?? 1
    return this.state.count
  }

  tag(payload: { name: string }) {
    this.state.tags = { ...this.state.tags, [payload.name]: Object.keys(this.state.tags).length + 1 }
    return true
  }

  untag(payload: { name: string }) {
    const next = { ...this.state.tags }
    delete next[payload.name]
    // setState passa pelo deep diff → a chave removida vira `null` aninhado no
    // delta. (Atribuir `this.state.tags = next` manda o objeto inteiro e o
    // cliente, que faz merge, manteria a chave antiga — ver .ai-notes/bugs.)
    this.setState({ tags: next })
    return true
  }

  clearOwner() {
    this.state.owner = null
    return true
  }

  fail() {
    throw new Error('falhou de propósito')
  }
}

class MemoryTransport implements LiveTransport {
  routes = new Map<string, RawHttpRoute>()
  registerWebSocket(_config: WebSocketConfig) {}
  registerHttpRoutes() {}
  registerRawRoutes(routes: RawHttpRoute[]) {
    for (const r of routes) this.routes.set(`${r.method} ${r.path}`, r)
  }
  fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init)
    const route = this.routes.get(`${req.method} ${new URL(req.url).pathname}`)
    if (!route) return new Response('not found', { status: 404 })
    return route.handler(req)
  }) as typeof fetch
}

let server: LiveServer | null = null
let mounted: Mounted<UseLiveComponentReturn<BoardState>> | null = null
const extraApps: Array<Mounted<UseLiveComponentReturn<BoardState>>> = []
const extraServers: LiveServer[] = []

afterEach(async () => {
  mounted?.unmount()
  mounted = null
  for (const m of extraApps.splice(0)) m.unmount()
  await server?.shutdown()
  server = null
  for (const s of extraServers.splice(0)) await s.shutdown()
  delete (globalThis as { localStorage?: unknown }).localStorage
})

const SECRET = 'segredo-de-teste-rehidratacao-vue'

/** Servidor real em memória (renovação do signedState a cada 100 ms). */
async function startServer(renewInterval = 100) {
  const transport = new MemoryTransport()
  const s = new LiveServer({
    transport,
    components: [VueBoard as never],
    httpPrefix: false,
    sse: { heartbeatMs: 0 },
    stateSignature: { secret: SECRET, renewInterval },
  })
  await s.start()
  return { server: s, transport }
}

function mountApp(fetchImpl: typeof fetch, options: UseLiveComponentOptions = {}) {
  return mountWithLive(
    {
      url: 'ws://app.test/api/live/ws',
      transport: (ep) => new SseClientTransport(ep.sseUrl, { fetch: fetchImpl }),
      heartbeatInterval: 60_000,
      reconnectInterval: 10,
    },
    () => useLive<BoardState>('VueBoard', { count: 0, owner: 'client', tags: {} }, options),
  )
}

async function setup(options: UseLiveComponentOptions = {}) {
  const started = await startServer()
  server = started.server
  mounted = mountApp(started.transport.fetch, options)
  return { server: started.server, transport: started.transport, m: mounted, live: mounted.child }
}

/** count dentro do signedState (estado pequeno: sem compressão, data é JSON). */
const signedCount = (live: UseLiveComponentReturn<BoardState>): number | undefined => {
  const s = live.signedState.value
  return s ? (JSON.parse(s.data) as { count?: number }).count : undefined
}

/** Derruba o stream como uma queda de rede (não é disconnect() intencional) e espera remontar. */
async function dropAndWaitReconnect(m: Mounted<UseLiveComponentReturn<BoardState>>) {
  const firstConn = m.ctx.connectionId.value
  m.ctx.connection.getTransport()!.close()
  await until(() => !m.ctx.connected.value || m.ctx.connectionId.value !== firstConn)
  await until(
    () => m.ctx.connected.value && !!m.ctx.connectionId.value && m.ctx.connectionId.value !== firstConn && m.child.mounted.value,
    5000,
  )
}

class MemoryStorage {
  store = new Map<string, string>()
  getItem(k: string) { return this.store.get(k) ?? null }
  setItem(k: string, v: string) { this.store.set(k, v) }
  removeItem(k: string) { this.store.delete(k) }
}

type Persisted = { signedState: { data: string } }
const STORAGE_KEY = 'fluxstack_component_VueBoard'

const componentsOnServer = () => server!.registry.getStats().components

describe('useLive + LiveServer real (SSE)', () => {
  it('conecta pelo SSE e monta com o estado inicial do servidor', async () => {
    const { m, live } = await setup()
    await until(() => live.mounted.value)

    expect(m.ctx.connected.value).toBe(true)
    expect(m.ctx.transport.value).toBe('sse')
    expect(m.ctx.connectionId.value).toBeTruthy()
    expect(live.componentId.value).toBeTruthy()
    // props do mount = estado inicial do cliente; o servidor aplica sobre o defaultState
    expect(live.state.owner).toBe('client')
    expect(componentsOnServer()).toBe(1)
  })

  it('action executa no servidor e o STATE_DELTA chega ao estado reativo', async () => {
    const { live } = await setup()
    await until(() => live.mounted.value)

    await expect(live.call('increment', { by: 3 })).resolves.toBe(3)
    await until(() => live.state.count === 3)
    await live.call('increment')
    await until(() => live.state.count === 4)
  })

  it('deltas aninhados: chave adicionada e removida; null top-level vira valor', async () => {
    const { live } = await setup()
    await until(() => live.mounted.value)

    await live.call('tag', { name: 'a' })
    await live.call('tag', { name: 'b' })
    await until(() => Object.keys(live.state.tags).length === 2)

    await live.call('untag', { name: 'a' })
    await until(() => !('a' in live.state.tags))
    expect(live.state.tags).toEqual({ b: 2 })

    await live.call('clearOwner')
    await until(() => live.state.owner === null)
    expect('owner' in live.state).toBe(true)
  })

  it('erro da action rejeita a promessa e aparece em error', async () => {
    const { live } = await setup()
    await until(() => live.mounted.value)
    await expect(live.call('fail')).rejects.toThrow(/falhou de propósito/)
    expect(live.error.value).toMatch(/falhou de propósito/)
  })

  it('action fora de publicActions é recusada', async () => {
    const { live } = await setup()
    await until(() => live.mounted.value)
    await expect(live.call('constructor')).rejects.toThrow()
    expect(live.error.value).toBeTruthy()
  })

  it('desmontar o app libera o componente e a conexão no servidor', async () => {
    const { server, m, live } = await setup()
    await until(() => live.mounted.value)
    expect(server.sseHub?.size).toBe(1)

    m.unmount()
    await until(() => componentsOnServer() === 0)
    await until(() => server.sseHub?.size === 0)
  })

  it('auto-reconnect: queda do transporte → reconecta e RE-HIDRATA (5, não 0); próxima action dá 6', async () => {
    const { server, m, live } = await setup()
    await until(() => live.mounted.value)
    expect(signedCount(live)).toBe(0) // token do mount

    for (let i = 0; i < 5; i++) await live.call('increment')
    await until(() => live.state.count === 5)
    // renovação throttled (STATE_SIGNATURE) com o estado final da rajada
    await until(() => signedCount(live) === 5)
    const firstId = live.componentId.value
    const versionBefore = live.signedState.value!.version

    await dropAndWaitReconnect(m)
    expect(live.componentId.value).not.toBe(firstId)
    expect(live.state.count).toBe(5)
    expect(live.state.owner).toBe('client') // o resto do estado também veio do token
    expect(live.signedState.value!.version).toBeGreaterThan(versionBefore) // STATE_REHYDRATED = versão+1

    await expect(live.call('increment')).resolves.toBe(6)
    await until(() => live.state.count === 6)

    // o componente da conexão antiga foi limpo pelo servidor
    await until(() => componentsOnServer() === 1)
    expect(server.sseHub?.size).toBe(1)
  })

  it('persistState: false → reconexão remonta do zero (defaultState/props)', async () => {
    const { m, live } = await setup({ persistState: false })
    await until(() => live.mounted.value)
    await live.call('increment', { by: 5 })
    await until(() => live.state.count === 5)
    await until(() => signedCount(live) === 5)

    await dropAndWaitReconnect(m)
    expect(live.state.count).toBe(0)
    await expect(live.call('increment', { by: 2 })).resolves.toBe(2)
  })

  it('restart do servidor (mesmo segredo): o token renovado semeia a instância nova', async () => {
    const first = await startServer()
    let current = first.transport
    const fetchVia = ((input: RequestInfo | URL, init?: RequestInit) => current.fetch(input, init)) as typeof fetch
    extraServers.push(first.server)
    const m = mountApp(fetchVia)
    extraApps.push(m)
    const live = m.child
    await until(() => live.mounted.value)
    await live.call('increment', { by: 5 })
    await until(() => signedCount(live) === 5)

    const second = await startServer()
    extraServers.push(second.server)
    current = second.transport
    await first.server.shutdown() // fecha os streams SSE → cliente reconecta no novo

    await until(() => m.ctx.connected.value && live.mounted.value && second.server.registry.getStats().components === 1, 5000)
    expect(live.state.count).toBe(5)
    await expect(live.call('increment')).resolves.toBe(6)
  })

  it('re-hidratação recusada (assinatura ADULTERADA no localStorage) cai para o mount normal', async () => {
    const storage = new MemoryStorage()
    ;(globalThis as { localStorage?: unknown }).localStorage = storage
    const { transport, live } = await setup()
    await until(() => live.mounted.value)
    await live.call('increment', { by: 5 })
    await until(() => signedCount(live) === 5)
    const stored = () => JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null') as Persisted | null
    await until(() => !!stored()?.signedState.data.includes('"count":5'))

    // "reload" com o token adulterado: count 5 → 500 mantendo a assinatura
    mounted!.unmount()
    mounted = null
    const persisted = stored()!
    persisted.signedState.data = persisted.signedState.data.replace('"count":5', '"count":500')
    storage.setItem(STORAGE_KEY, JSON.stringify(persisted))

    const m2 = mountApp(transport.fetch)
    extraApps.push(m2)
    await until(() => m2.child.mounted.value, 5000)
    expect(m2.child.state.count).toBe(0) // mount do zero, não 500 nem 5
    expect(m2.child.error.value).toBeNull()
    // o token recusado foi trocado pelo do mount novo
    expect(stored()?.signedState.data).toContain('"count":0')
    await expect(m2.child.call('increment')).resolves.toBe(1)
  })

  it('"reload" com token íntegro no localStorage re-hidrata do estado mais recente', async () => {
    const storage = new MemoryStorage()
    ;(globalThis as { localStorage?: unknown }).localStorage = storage
    const { transport, live } = await setup()
    await until(() => live.mounted.value)
    await live.call('increment', { by: 5 })
    await until(() => signedCount(live) === 5)

    mounted!.unmount()
    mounted = null
    const m2 = mountApp(transport.fetch)
    extraApps.push(m2)
    await until(() => m2.child.mounted.value, 5000)
    expect(m2.child.state.count).toBe(5)
    await expect(m2.child.call('increment')).resolves.toBe(6)
  })
})
