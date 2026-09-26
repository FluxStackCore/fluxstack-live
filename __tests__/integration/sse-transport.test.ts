// Integração ponta a ponta do transporte SSE:
//   LiveServer real (sse: true)  ⇄  LiveConnection real (transport: 'sse')
// ligados por um `fetch` em memória que roteia para as rotas cruas registradas.
// Nenhuma porta de rede é aberta; todo o caminho HTTP/stream é exercitado.
import { describe, it, expect, afterEach } from 'vitest'
import { LiveServer } from '../../packages/core/src/server/LiveServer'
import { LiveComponent } from '../../packages/core/src/component/LiveComponent'
import type { LiveTransport, RawHttpRoute, WebSocketConfig } from '../../packages/core/src/transport/types'
import { LiveConnection } from '../../packages/client/src/connection'
import { SseClientTransport, SseParser } from '../../packages/client/src/transports'
import type { WebSocketResponse } from '../../packages/core/src/protocol/messages'

class SseCounter extends LiveComponent<{ count: number }> {
  static componentName = 'SseCounter'
  static defaultState = { count: 0 }
  static publicActions = ['increment'] as const
  increment(payload: { by?: number } = {}) {
    this.state.count += payload.by ?? 1
    return this.state.count
  }
}

/** Transporte de servidor mínimo que só guarda as rotas cruas. */
class MemoryTransport implements LiveTransport {
  routes = new Map<string, RawHttpRoute>()
  registerWebSocket(_config: WebSocketConfig) {}
  registerHttpRoutes() {}
  registerRawRoutes(routes: RawHttpRoute[]) {
    for (const r of routes) this.routes.set(`${r.method} ${r.path}`, r)
  }
  /** `fetch` compatível que despacha para as rotas registradas. */
  fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init)
    const url = new URL(req.url)
    const route = this.routes.get(`${req.method} ${url.pathname}`)
    if (!route) return new Response('not found', { status: 404 })
    return route.handler(req)
  }) as typeof fetch
}

const until = async (cond: () => boolean, ms = 3000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout esperando condição')
    await new Promise(r => setTimeout(r, 5))
  }
}

describe('transporte SSE (integração)', () => {
  let server: LiveServer | null = null
  let conn: LiveConnection | null = null

  afterEach(async () => {
    conn?.destroy()
    conn = null
    await server?.shutdown()
    server = null
  })

  async function setup(opts: { allowedOrigins?: string[] } = {}) {
    const transport = new MemoryTransport()
    server = new LiveServer({
      transport,
      components: [SseCounter as never],
      httpPrefix: false,
      sse: { heartbeatMs: 0 },
      allowedOrigins: opts.allowedOrigins,
    })
    await server.start()
    conn = new LiveConnection({
      url: 'ws://app.test/api/live/ws',
      transport: (ep) => new SseClientTransport(ep.sseUrl, { fetch: transport.fetch }),
      autoConnect: true,
      heartbeatInterval: 60_000,
    })
    return { transport, server, conn }
  }

  it('registra as rotas GET /api/live/sse e POST /api/live/sse/send', async () => {
    const { transport } = await setup()
    expect([...transport.routes.keys()].sort()).toEqual(['GET /api/live/sse', 'POST /api/live/sse/send'])
  })

  it('conecta, monta componente, executa action e recebe o delta de estado', async () => {
    const { conn, server } = await setup()
    await until(() => conn.state.connected && !!conn.state.connectionId)
    expect(conn.state.transport).toBe('sse')
    expect(server.sseHub?.size).toBe(1)

    const mount = await conn.sendMessageAndWait({
      type: 'COMPONENT_MOUNT',
      componentId: '',
      payload: { component: 'SseCounter', props: {} },
    } as never)
    const componentId = (mount.result as { componentId: string }).componentId
    expect(componentId).toBeTruthy()

    const received: WebSocketResponse[] = []
    conn.registerComponent(componentId, (msg) => received.push(msg))

    const res = await conn.sendMessageAndWait({
      type: 'CALL_ACTION',
      componentId,
      action: 'increment',
      payload: { by: 5 },
    } as never)
    expect(res.success).toBe(true)
    expect(res.result).toBe(5)

    // o delta chega pelo stream SSE (batched pelo WsSendBatcher)
    await until(() => received.some(m => m.type === 'STATE_DELTA'))
    const delta = received.find(m => m.type === 'STATE_DELTA') as { payload: { delta: { count: number } } } | undefined
    expect(delta?.payload.delta.count).toBe(5)
  })

  it('fechar o cliente libera a conexão no servidor', async () => {
    const { conn, server } = await setup()
    await until(() => conn.state.connected)
    conn.disconnect()
    await until(() => server.sseHub?.size === 0)
  })

  it('POST com token desconhecido responde 404', async () => {
    const { transport } = await setup()
    const res = await transport.fetch('http://app.test/api/live/sse/send', {
      method: 'POST',
      headers: { 'x-live-session': 'forjado', 'content-type': 'application/json' },
      body: '{"type":"PING"}',
    })
    expect(res.status).toBe(404)
  })

  it('origem fora da allowlist recebe 403 e o cliente não fica reconectando', async () => {
    const transport = new MemoryTransport()
    server = new LiveServer({ transport, httpPrefix: false, sse: { heartbeatMs: 0 }, allowedOrigins: ['https://ok.test'] })
    await server.start()
    const res = await transport.fetch('http://app.test/api/live/sse', { headers: { origin: 'https://evil.test' } })
    expect(res.status).toBe(403)
    expect(server.sseHub?.size).toBe(0)
  })

  it('servidor encerra o stream no shutdown com evento close', async () => {
    const transport = new MemoryTransport()
    server = new LiveServer({ transport, httpPrefix: false, sse: { heartbeatMs: 0 } })
    await server.start()
    const res = await transport.fetch('http://app.test/api/live/sse')
    const reader = res.body!.getReader()
    const parser = new SseParser()
    const events: string[] = []
    const read = (async () => {
      const dec = new TextDecoder()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        for (const ev of parser.push(dec.decode(value, { stream: true }))) events.push(ev.event)
      }
    })()
    await until(() => events.includes('message')) // CONNECTION_ESTABLISHED
    expect(events[0]).toBe('session')
    await server.shutdown()
    server = null
    await read
    expect(events.at(-1)).toBe('close')
  })
})

describe('SseParser', () => {
  it('lida com chunks partidos, CRLF, multi-linha e comentários', () => {
    const p = new SseParser()
    const out = [
      ...p.push('event: mess'),
      ...p.push('age\r\ndata: {"a":\r\n'),
      ...p.push('data: 1}\r\n\r\n: ping\n\nevent: binary\ndata: AAE=\n'),
      ...p.push('\n'),
    ]
    expect(out).toEqual([
      { event: 'message', data: '{"a":\n1}' },
      { event: 'binary', data: 'AAE=' },
    ])
  })
})
