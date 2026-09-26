// Robustez dos transportes SSE e HTTP do lado do cliente, em memória:
//  - frames binários chegam ao cliente como ArrayBuffer idênticos
//  - SSE openTimeoutMs: stream que "abre" e nunca manda `session` → o cliente
//    fecha e, na cadeia ['sse', 'http'], desce para HTTP
//  - servidor reinicia → LiveConnection (SSE e HTTP) reconecta sozinho
//  - mesma app, transportes mistos: cliente SSE e cliente HTTP no mesmo
//    LiveServer enxergam as mudanças um do outro (singleton e LiveRoom)
import { describe, it, expect, afterEach } from 'vitest'
import { LiveServer } from '../../packages/core/src/server/LiveServer'
import { LiveComponent } from '../../packages/core/src/component/LiveComponent'
import { LiveRoom } from '../../packages/core/src/rooms/LiveRoom'
import { SseConnectionHub } from '../../packages/core/src/transport/sse'
import { HttpPollingHub } from '../../packages/core/src/transport/http-polling'
import type { GenericWebSocket, LiveTransport, RawHttpRoute, WebSocketConfig } from '../../packages/core/src/transport/types'
import { LiveConnection } from '../../packages/client/src/connection'
import {
  HttpPollingClientTransport,
  SseClientTransport,
  type ClientTransportFactory,
  type ClientTransportHandlers,
} from '../../packages/client/src/transports'
import type { WebSocketResponse } from '../../packages/core/src/protocol/messages'

// ── componentes ──────────────────────────────────────────────────────────────

class ResCounter extends LiveComponent<{ count: number }> {
  static componentName = 'ResCounter'
  static defaultState = { count: 0 }
  static publicActions = ['increment'] as const
  increment() {
    this.state.count += 1
    return this.state.count
  }
}

class SharedBoard extends LiveComponent<{ count: number; lastBy: string }> {
  static componentName = 'SharedBoard'
  static singleton = true
  static defaultState = { count: 0, lastBy: '' }
  static publicActions = ['bump'] as const
  bump(payload: unknown) {
    const by = typeof payload === 'object' && payload !== null && typeof (payload as { by?: unknown }).by === 'string'
      ? (payload as { by: string }).by : '?'
    this.state.count += 1
    this.state.lastBy = by
    return this.state.count
  }
}

class MixRoom extends LiveRoom<{ messages: string[] }, Record<string, never>, { said: { text: string } }> {
  static roomName = 'mix'
  static defaultState = { messages: [] as string[] }
}

class MixChat extends LiveComponent<{ joined: boolean }> {
  static componentName = 'MixChat'
  static defaultState = { joined: false }
  static publicActions = ['join', 'say'] as const
  join() {
    this.$room(MixRoom, 'lobby').join()
    this.state.joined = true
    return true
  }
  say(payload: unknown) {
    const text = typeof payload === 'object' && payload !== null ? String((payload as { text?: unknown }).text ?? '') : ''
    this.$room(MixRoom, 'lobby').emit('said', { text })
    return true
  }
}

// ── infraestrutura em memória ────────────────────────────────────────────────

/** Transporte de servidor que guarda as rotas cruas e expõe um `fetch` em memória. */
class MemoryTransport implements LiveTransport {
  routes = new Map<string, RawHttpRoute>()
  /** servidor "fora do ar": responde 503 em tudo */
  down = false
  registerWebSocket(_config: WebSocketConfig) {}
  registerHttpRoutes() {}
  registerRawRoutes(routes: RawHttpRoute[]) {
    for (const r of routes) this.routes.set(`${r.method} ${r.path}`, r)
  }
  fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
    const req = new Request(input, init)
    if (this.down) return new Response('down', { status: 503 })
    const route = this.routes.get(`${req.method} ${new URL(req.url).pathname}`)
    if (!route) return new Response('not found', { status: 404 })
    const pending = Promise.resolve(route.handler(req))
    if (!init?.signal) return pending
    return Promise.race([pending, new Promise<Response>((_, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })])
  }) as typeof fetch
}

const until = async (cond: () => boolean, ms = 5000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout esperando condição')
    await new Promise(r => setTimeout(r, 5))
  }
}

function recorder() {
  const opened: GenericWebSocket[] = []
  const config: Omit<WebSocketConfig, 'path'> = {
    onOpen: (ws) => { opened.push(ws) },
    onMessage: () => {},
    onClose: () => {},
  }
  return { config, opened }
}

function handlersSpy() {
  const events = {
    opened: 0,
    messages: [] as Array<string | ArrayBuffer>,
    closed: [] as Array<{ code: number; reason: string }>,
    errors: [] as Error[],
  }
  const handlers: ClientTransportHandlers = {
    onOpen: () => { events.opened++ },
    onMessage: (d) => { events.messages.push(d) },
    onClose: (code, reason) => { events.closed.push({ code, reason }) },
    onError: (e) => { events.errors.push(e) },
  }
  return { events, handlers }
}

async function mount(conn: LiveConnection, component: string): Promise<string> {
  const res = await conn.sendMessageAndWait({
    type: 'COMPONENT_MOUNT', componentId: '', payload: { component, props: {} },
  } as never)
  const id = (res.result as { componentId?: string } | undefined)?.componentId
  if (!id) throw new Error(`mount de ${component} falhou: ${JSON.stringify(res)}`)
  return id
}

function call(conn: LiveConnection, componentId: string, action: string, payload: unknown = {}) {
  return conn.sendMessageAndWait({ type: 'CALL_ACTION', componentId, action, payload } as never)
}

const sseFactory = (t: MemoryTransport, openTimeoutMs?: number): ClientTransportFactory =>
  (ep) => new SseClientTransport(ep.sseUrl, { fetch: t.fetch, openTimeoutMs })
const httpFactory = (t: MemoryTransport): ClientTransportFactory =>
  (ep) => new HttpPollingClientTransport(ep.httpUrl, { fetch: t.fetch })

// ─────────────────────────────────────────────────────────────────────────────

describe('frames binários chegam ao cliente como ArrayBuffer idênticos', () => {
  const bytes = new Uint8Array(2048).map((_, i) => (i * 13 + 7) & 0xff)

  it('HTTP long-polling', async () => {
    const t = new MemoryTransport()
    const rec = recorder()
    const hub = new HttpPollingHub(rec.config, { pollTimeoutMs: 1000 })
    t.registerRawRoutes(hub.routes())
    const client = new HttpPollingClientTransport('http://app.test/api/live/http', { fetch: t.fetch })
    const { events, handlers } = handlersSpy()
    client.open(handlers)
    await until(() => events.opened === 1 && rec.opened.length === 1)

    rec.opened[0]!.send(bytes)
    rec.opened[0]!.send('{"texto":"depois do binário"}')
    await until(() => events.messages.length >= 2)
    expect(events.messages[0]).toBeInstanceOf(ArrayBuffer)
    expect(new Uint8Array(events.messages[0] as ArrayBuffer)).toEqual(bytes)
    expect(events.messages[1]).toBe('{"texto":"depois do binário"}')
    client.close()
    hub.closeAll()
  })

  it('SSE', async () => {
    const t = new MemoryTransport()
    const rec = recorder()
    const hub = new SseConnectionHub(rec.config, { heartbeatMs: 0 })
    t.registerRawRoutes(hub.routes())
    const client = new SseClientTransport('http://app.test/api/live/sse', { fetch: t.fetch })
    const { events, handlers } = handlersSpy()
    client.open(handlers)
    await until(() => events.opened === 1)

    rec.opened[0]!.send(bytes)
    await until(() => events.messages.length >= 1)
    expect(events.messages[0]).toBeInstanceOf(ArrayBuffer)
    expect(new Uint8Array(events.messages[0] as ArrayBuffer)).toEqual(bytes)
    client.close()
    hub.closeAll()
  })

  it('HTTP: cliente envia binário e o servidor recebe os mesmos bytes', async () => {
    const t = new MemoryTransport()
    const received: Array<{ message: unknown; isBinary: boolean }> = []
    const hub = new HttpPollingHub({
      onOpen: () => {}, onClose: () => {},
      onMessage: (_ws, message, isBinary) => { received.push({ message, isBinary }) },
    }, { pollTimeoutMs: 1000 })
    t.registerRawRoutes(hub.routes())
    const client = new HttpPollingClientTransport('http://app.test/api/live/http', { fetch: t.fetch })
    const { events, handlers } = handlersSpy()
    client.open(handlers)
    await until(() => events.opened === 1)
    client.send(bytes.slice().buffer)
    await until(() => received.length === 1)
    expect(received[0]!.isBinary).toBe(true)
    expect(new Uint8Array(received[0]!.message as ArrayBuffer)).toEqual(bytes)
    client.close()
    hub.closeAll()
  })
})

describe('SSE openTimeoutMs (proxy que bufferiza o stream)', () => {
  /** Transporte cujo GET /api/live/sse responde 200 e nunca entrega nada. */
  function bufferingProxy(t: MemoryTransport) {
    const state = { opens: 0, cancelled: 0 }
    t.routes.set('GET /api/live/sse', {
      method: 'GET',
      path: '/api/live/sse',
      handler: () => {
        state.opens++
        const stream = new ReadableStream<Uint8Array>({ cancel() { state.cancelled++ } })
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
      },
    })
    return state
  }

  it('sem evento `session` dentro do prazo → fecha com 1006 sem nunca abrir', async () => {
    const t = new MemoryTransport()
    const proxy = bufferingProxy(t)
    const client = new SseClientTransport('http://app.test/api/live/sse', { fetch: t.fetch, openTimeoutMs: 60 })
    const { events, handlers } = handlersSpy()
    const t0 = Date.now()
    client.open(handlers)
    expect(client.isConnecting).toBe(true)
    await until(() => events.closed.length === 1)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(50)
    expect(events.opened).toBe(0)
    expect(events.closed[0]!.code).toBe(1006)
    expect(events.closed[0]!.reason).toMatch(/open timeout/)
    expect(client.isOpen).toBe(false)
    expect(client.isConnecting).toBe(false)
    // o stream pendurado é cancelado (não fica conexão presa)
    await until(() => proxy.cancelled === 1)
  })

  it("na cadeia ['sse', 'http'] desce para HTTP e funciona", async () => {
    const t = new MemoryTransport()
    const server = new LiveServer({
      transport: t, components: [ResCounter as never], httpPrefix: false, http: { pollTimeoutMs: 200 },
    })
    await server.start()
    const proxy = bufferingProxy(t) // SSE "abre" mas nunca entrega o session
    const conn = new LiveConnection({
      url: 'ws://app.test/api/live/ws',
      // cadeia com fábricas (para usar openTimeoutMs curto); mesma lógica de ['sse', 'http']
      transport: [sseFactory(t, 60), httpFactory(t)] as never,
      reconnectInterval: 5,
      heartbeatInterval: 60_000,
    })
    try {
      await until(() => conn.state.connected && !!conn.state.connectionId, 8000)
      expect(conn.state.transport).toBe('http')
      expect(proxy.opens).toBeGreaterThanOrEqual(2) // 2 falhas sem abrir → desce
      const id = await mount(conn, 'ResCounter')
      expect((await call(conn, id, 'increment')).result).toBe(1)
    } finally {
      conn.destroy()
      await server.shutdown()
    }
  }, 15_000)
})

describe('reconexão após o servidor reiniciar', () => {
  let conn: LiveConnection | null = null
  let server: LiveServer | null = null
  afterEach(async () => {
    conn?.destroy(); conn = null
    await server?.shutdown(); server = null
  })

  async function startServer(t: MemoryTransport) {
    const s = new LiveServer({
      transport: t,
      components: [ResCounter as never],
      httpPrefix: false,
      sse: { heartbeatMs: 0 },
      http: { pollTimeoutMs: 200 },
    })
    await s.start()
    return s
  }

  for (const mode of ['sse', 'http'] as const) {
    it(`${mode}: reconecta sozinho e volta a executar actions`, async () => {
      const t = new MemoryTransport()
      server = await startServer(t)
      conn = new LiveConnection({
        url: 'ws://app.test/api/live/ws',
        transport: mode === 'sse' ? sseFactory(t) : httpFactory(t),
        reconnectInterval: 10,
        heartbeatInterval: 60_000,
      })
      await until(() => !!conn!.state.connectionId)
      const firstConnectionId = conn.state.connectionId
      const id1 = await mount(conn, 'ResCounter')
      expect((await call(conn, id1, 'increment')).result).toBe(1)

      // servidor cai: fora do ar durante o restart (as tentativas falham)
      t.down = true
      const old = server
      await old.shutdown()
      await until(() => !conn!.state.connected)
      const hubOld = mode === 'sse' ? old.sseHub : old.httpPollingHub
      expect(hubOld?.size).toBe(0)
      await new Promise(r => setTimeout(r, 50)) // algumas tentativas batem no 503

      // novo processo sobe no mesmo endereço
      server = await startServer(t)
      t.down = false

      await until(() => conn!.state.connected && !!conn!.state.connectionId, 8000)
      expect(conn.state.connectionId).not.toBe(firstConnectionId)
      expect(conn.state.transport).toBe(mode)
      const hubNew = mode === 'sse' ? server.sseHub : server.httpPollingHub
      expect(hubNew?.size).toBe(1)

      // estado novo no servidor novo; actions voltam a funcionar
      const id2 = await mount(conn, 'ResCounter')
      const received: WebSocketResponse[] = []
      conn.registerComponent(id2, (m) => received.push(m))
      expect((await call(conn, id2, 'increment')).result).toBe(1)
      expect((await call(conn, id2, 'increment')).result).toBe(2)
      await until(() => received.some(m => m.type === 'STATE_DELTA'))
    }, 15_000)
  }
})

describe('mesma app, transportes mistos (SSE + HTTP no mesmo LiveServer)', () => {
  let server: LiveServer | null = null
  const conns: LiveConnection[] = []
  afterEach(async () => {
    for (const c of conns.splice(0)) c.destroy()
    await server?.shutdown(); server = null
  })

  async function setup() {
    const t = new MemoryTransport()
    server = new LiveServer({
      transport: t,
      components: [SharedBoard as never, MixChat as never],
      rooms: [MixRoom as never],
      httpPrefix: false,
      sse: { heartbeatMs: 0 },
      http: { pollTimeoutMs: 200 },
    })
    await server.start()
    const sse = new LiveConnection({ url: 'ws://app.test/api/live/ws', transport: sseFactory(t), heartbeatInterval: 60_000 })
    const http = new LiveConnection({ url: 'ws://app.test/api/live/ws', transport: httpFactory(t), heartbeatInterval: 60_000 })
    conns.push(sse, http)
    await until(() => !!sse.state.connectionId && !!http.state.connectionId)
    expect(sse.state.transport).toBe('sse')
    expect(http.state.transport).toBe('http')
    expect(server.sseHub?.size).toBe(1)
    expect(server.httpPollingHub?.size).toBe(1)
    return { sse, http }
  }

  /** Estado do componente visto pelo cliente (STATE_UPDATE + STATE_DELTAs acumulados). */
  function watchState(conn: LiveConnection, componentId: string) {
    const state: Record<string, unknown> = {}
    conn.registerComponent(componentId, (m) => {
      const p = (m as { payload?: { delta?: Record<string, unknown>; state?: Record<string, unknown> } }).payload
      if (m.type === 'STATE_DELTA' && p?.delta) Object.assign(state, p.delta)
      if (m.type === 'STATE_UPDATE' && p?.state) Object.assign(state, p.state)
    })
    return state
  }

  it('singleton: a action de um cliente aparece no outro, nos dois sentidos', async () => {
    const { sse, http } = await setup()
    const idSse = await mount(sse, 'SharedBoard')
    const idHttp = await mount(http, 'SharedBoard')
    const seenBySse = watchState(sse, idSse)
    const seenByHttp = watchState(http, idHttp)

    expect((await call(sse, idSse, 'bump', { by: 'sse' })).result).toBe(1)
    await until(() => seenByHttp.count === 1 && seenByHttp.lastBy === 'sse')

    expect((await call(http, idHttp, 'bump', { by: 'http' })).result).toBe(2)
    await until(() => seenBySse.count === 2 && seenBySse.lastBy === 'http')
  })

  it('LiveRoom: evento emitido pelo cliente HTTP chega ao cliente SSE e vice-versa', async () => {
    const { sse, http } = await setup()
    const idSse = await mount(sse, 'MixChat')
    const idHttp = await mount(http, 'MixChat')

    // eventos de sala chegam como frame binário 0x02 (msgpack) — no SSE em base64,
    // no HTTP como { b } — e são entregues aos handlers de sala do LiveConnection
    const roomMsgs = (conn: LiveConnection) => {
      const texts: string[] = []
      conn.registerRoomBinaryHandler((frame) => {
        expect(frame[0]).toBe(0x02)
        const txt = new TextDecoder().decode(frame)
        for (const w of ['de-http', 'de-sse']) if (txt.includes(w)) texts.push(w)
      })
      return texts
    }
    const gotSse = roomMsgs(sse)
    const gotHttp = roomMsgs(http)

    expect((await call(sse, idSse, 'join')).success).toBe(true)
    expect((await call(http, idHttp, 'join')).success).toBe(true)

    await call(http, idHttp, 'say', { text: 'de-http' })
    await until(() => gotSse.includes('de-http'))

    await call(sse, idSse, 'say', { text: 'de-sse' })
    await until(() => gotHttp.includes('de-sse'))
    // emit não ecoa para quem emitiu
    expect(gotHttp).not.toContain('de-http')
    expect(gotSse).not.toContain('de-sse')
  })
})
