// Integração do transporte HTTP puro (long-polling + POST) e da cadeia do modo
// 'auto' (websocket → sse → http). LiveServer real ⇄ LiveConnection real, por um
// `fetch` em memória que despacha para as rotas cruas registradas.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { LiveServer } from '../../packages/core/src/server/LiveServer'
import { LiveComponent } from '../../packages/core/src/component/LiveComponent'
import type { LiveTransport, RawHttpRoute, WebSocketConfig } from '../../packages/core/src/transport/types'
import { LiveConnection } from '../../packages/client/src/connection'
import { HttpPollingClientTransport } from '../../packages/client/src/transports'
import type { WebSocketResponse } from '../../packages/core/src/protocol/messages'

class HttpCounter extends LiveComponent<{ count: number }> {
  static componentName = 'HttpCounter'
  static defaultState = { count: 0 }
  static publicActions = ['increment'] as const
  increment(payload: unknown) {
    const by = typeof payload === 'object' && payload !== null && typeof (payload as { by?: unknown }).by === 'number'
      ? (payload as { by: number }).by : 1
    this.state.count += by
    return this.state.count
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
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
    const route = this.routes.get(`${req.method} ${new URL(req.url).pathname}`)
    if (!route) return new Response('not found', { status: 404 })
    const pending = Promise.resolve(route.handler(req))
    // respeita o abort do cliente (long-poll pendente quando ele desconecta)
    if (!init?.signal) return pending
    return Promise.race([pending, new Promise<Response>((_, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })])
  }) as typeof fetch
}

const until = async (cond: () => boolean, ms = 4000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout esperando condição')
    await new Promise(r => setTimeout(r, 5))
  }
}

describe('transporte HTTP long-polling (integração)', () => {
  let server: LiveServer | null = null
  let conn: LiveConnection | null = null

  afterEach(async () => {
    conn?.destroy(); conn = null
    await server?.shutdown(); server = null
    vi.unstubAllGlobals()
  })

  async function setup(httpOpts: Record<string, unknown> = {}) {
    const transport = new MemoryTransport()
    server = new LiveServer({
      transport,
      components: [HttpCounter as never],
      httpPrefix: false,
      http: { pollTimeoutMs: 200, ...httpOpts },
    })
    await server.start()
    return { transport, server }
  }

  it('registra GET /api/live/http, GET /poll, POST /send e POST /close', async () => {
    const { transport } = await setup()
    expect([...transport.routes.keys()].sort()).toEqual([
      'GET /api/live/http', 'GET /api/live/http/poll', 'POST /api/live/http/close', 'POST /api/live/http/send',
    ])
  })

  it('desconectar o cliente encerra a sessão no servidor na hora (POST /close)', async () => {
    const { transport, server } = await setup({ pollTimeoutMs: 5000 })
    conn = new LiveConnection({
      url: 'ws://app.test/api/live/ws',
      transport: (ep) => new HttpPollingClientTransport(ep.httpUrl, { fetch: transport.fetch }),
      heartbeatInterval: 60_000,
    })
    await until(() => conn!.state.connected)
    expect(server.httpPollingHub?.size).toBe(1)
    conn.disconnect()
    await until(() => server.httpPollingHub?.size === 0, 1000)
  })

  it('conecta, monta, executa action e recebe o delta pelo poll', async () => {
    const { transport, server } = await setup()
    conn = new LiveConnection({
      url: 'ws://app.test/api/live/ws',
      transport: (ep) => new HttpPollingClientTransport(ep.httpUrl, { fetch: transport.fetch }),
      heartbeatInterval: 60_000,
    })
    await until(() => !!conn!.state.connectionId)
    expect(conn.state.transport).toBe('http')
    expect(server.httpPollingHub?.size).toBe(1)

    const mount = await conn.sendMessageAndWait({
      type: 'COMPONENT_MOUNT', componentId: '', payload: { component: 'HttpCounter', props: {} },
    } as never)
    const componentId = (mount.result as { componentId: string }).componentId
    const received: WebSocketResponse[] = []
    conn.registerComponent(componentId, (m) => received.push(m))

    const res = await conn.sendMessageAndWait({
      type: 'CALL_ACTION', componentId, action: 'increment', payload: { by: 3 },
    } as never)
    expect(res.result).toBe(3)
    await until(() => received.some(m => m.type === 'STATE_DELTA'))
  })

  it('poll vazio responde após o timeout sem derrubar a sessão', async () => {
    const { transport, server } = await setup({ pollTimeoutMs: 50 })
    const open = await (await transport.fetch('http://app.test/api/live/http')).json() as { token: string }
    const headers = { 'x-live-session': open.token }
    const first = await (await transport.fetch('http://app.test/api/live/http/poll', { headers })).json() as { frames: unknown[] }
    expect(first.frames.length).toBeGreaterThan(0) // CONNECTION_ESTABLISHED
    const t0 = Date.now()
    const empty = await (await transport.fetch('http://app.test/api/live/http/poll', { headers })).json() as { frames: unknown[] }
    expect(empty.frames).toEqual([])
    expect(Date.now() - t0).toBeGreaterThanOrEqual(40)
    expect(server.httpPollingHub?.size).toBe(1)
  })

  it('token desconhecido → 404 em poll e send', async () => {
    const { transport } = await setup()
    const headers = { 'x-live-session': 'forjado' }
    expect((await transport.fetch('http://app.test/api/live/http/poll', { headers })).status).toBe(404)
    expect((await transport.fetch('http://app.test/api/live/http/send', { method: 'POST', headers, body: '{}' })).status).toBe(404)
  })

  it('sessão abandonada expira no sweep e libera a conexão', async () => {
    const { transport, server } = await setup({ pollTimeoutMs: 20, sessionTimeoutMs: 50 })
    await transport.fetch('http://app.test/api/live/http')
    expect(server.httpPollingHub?.size).toBe(1)
    server.httpPollingHub!.sweep(Date.now() + 10_000)
    expect(server.httpPollingHub?.size).toBe(0)
  })

  it('shutdown entrega "closed" ao poll pendente', async () => {
    const { transport } = await setup({ pollTimeoutMs: 5000 })
    const open = await (await transport.fetch('http://app.test/api/live/http')).json() as { token: string }
    const headers = { 'x-live-session': open.token }
    await transport.fetch('http://app.test/api/live/http/poll', { headers }) // drena CONNECTION_ESTABLISHED
    const pending = transport.fetch('http://app.test/api/live/http/poll', { headers })
    await new Promise(r => setTimeout(r, 20))
    await server!.shutdown(); server = null
    const body = await (await pending).json() as { closed?: { code: number } }
    expect(body.closed?.code).toBe(1001)
  })

  it("cadeia ['sse', 'http'] (padrão do app): SSE indisponível → HTTP", async () => {
    const { transport } = await setup() // servidor sem SSE: /api/live/sse → 404
    vi.stubGlobal('fetch', transport.fetch)
    conn = new LiveConnection({
      url: 'ws://app.test/api/live/ws',
      transport: ['sse', 'http'],
      reconnectInterval: 5,
      heartbeatInterval: 60_000,
    })
    await until(() => conn!.state.connected, 8000)
    expect(conn.state.transport).toBe('http')
  }, 15_000)

  it("modo 'auto': sem WebSocket e sem SSE, cai para HTTP e funciona", async () => {
    // Servidor só com HTTP: /api/live/sse não existe (404) → SSE nunca abre.
    const { transport } = await setup()
    vi.stubGlobal('fetch', transport.fetch)
    // WebSocket bloqueado: fecha sem nunca abrir (proxy/firewall)
    class BlockedWebSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3
      readyState = 0
      binaryType = 'arraybuffer'
      onopen: (() => void) | null = null
      onmessage: ((e: MessageEvent) => void) | null = null
      onerror: (() => void) | null = null
      onclose: ((e: { code: number; reason: string }) => void) | null = null
      constructor(_url: string) {
        setTimeout(() => { this.readyState = 3; this.onerror?.(); this.onclose?.({ code: 1006, reason: 'blocked' }) }, 0)
      }
      send() { throw new Error('not open') }
      close() {}
    }
    vi.stubGlobal('WebSocket', BlockedWebSocket)

    conn = new LiveConnection({
      url: 'ws://app.test/api/live/ws',
      transport: 'auto',
      reconnectInterval: 5,
      heartbeatInterval: 60_000,
    })
    await until(() => conn!.state.connected, 8000)
    expect(conn.state.transport).toBe('http')

    const mount = await conn.sendMessageAndWait({
      type: 'COMPONENT_MOUNT', componentId: '', payload: { component: 'HttpCounter', props: {} },
    } as never)
    const componentId = (mount.result as { componentId: string }).componentId
    const res = await conn.sendMessageAndWait({ type: 'CALL_ACTION', componentId, action: 'increment', payload: {} } as never)
    expect(res.result).toBe(1)
  }, 15_000)
})
