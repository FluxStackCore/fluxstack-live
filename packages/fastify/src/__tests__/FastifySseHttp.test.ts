// Transportes SSE e HTTP long-polling com Fastify REAL em porta de rede.
//
// LiveServer + FastifyTransport (app.listen na porta 0) ⇄ LiveConnection real
// (transport 'sse' / 'http') usando o `fetch` global do Node. As rotas cruas
// vivem num escopo encapsulado cujo parser NÃO consome o corpo; a ponte
// Node ⇄ Fetch lê o corpo cru (JSON ou binário) de `req.raw`.

import { describe, it, expect, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import net, { type AddressInfo } from 'net'
import { LiveServer, LiveComponent, SseConnectionHub, HttpPollingHub } from '@fluxstack/live'
import type { GenericWebSocket, WebSocketConfig } from '@fluxstack/live'
import { LiveConnection } from '@fluxstack/live-client'
import { FastifyTransport } from '../index'

class NetCounter extends LiveComponent<{ count: number; text: string }> {
  static componentName = 'NetCounter'
  static defaultState = { count: 0, text: '' }
  static publicActions = ['increment', 'echo'] as const

  increment(payload: unknown) {
    const by = typeof payload === 'object' && payload !== null && typeof (payload as { by?: unknown }).by === 'number'
      ? (payload as { by: number }).by : 1
    this.state.count += by
    return this.state.count
  }

  echo(payload: unknown) {
    const text = typeof payload === 'object' && payload !== null ? String((payload as { text?: unknown }).text ?? '') : ''
    this.state.text = text
    return text
  }
}

type Delta = { type: string; payload?: { delta?: Record<string, unknown> } }

const until = async (cond: () => boolean, ms = 5000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout esperando condição')
    await new Promise(r => setTimeout(r, 10))
  }
}

async function listen(app: FastifyInstance): Promise<number> {
  await app.listen({ port: 0, host: '127.0.0.1' })
  return (app.server.address() as AddressInfo).port
}

describe('FastifyTransport — SSE e HTTP em porta real', () => {
  let app: FastifyInstance | null = null
  let live: LiveServer | null = null
  let conn: LiveConnection | null = null

  afterEach(async () => {
    conn?.destroy()
    conn = null
    await live?.shutdown()
    live = null
    app?.server.closeAllConnections?.()
    await app?.close()
    app = null
  })

  async function start() {
    app = Fastify()
    await app.register(websocket)
    live = new LiveServer({
      transport: new FastifyTransport(app),
      components: [NetCounter as never],
      httpPrefix: false,
      sse: { heartbeatMs: 0 },
      http: { pollTimeoutMs: 300 },
    })
    await live.start()
    const port = await listen(app)
    return { port, live }
  }

  for (const mode of ['sse', 'http'] as const) {
    it(`${mode}: conecta, monta, action, recebe STATE_DELTA e desconectar libera a sessão`, async () => {
      const { port, live } = await start()
      const c = new LiveConnection({
        url: `ws://127.0.0.1:${port}/api/live/ws`,
        transport: mode,
        reconnectInterval: 50,
        heartbeatInterval: 60_000,
      })
      conn = c
      await until(() => c.state.connected && !!c.state.connectionId)
      expect(c.state.transport).toBe(mode)
      const hub = mode === 'sse' ? live.sseHub : live.httpPollingHub
      expect(hub?.size).toBe(1)

      const mount = await c.sendMessageAndWait({
        type: 'COMPONENT_MOUNT', componentId: '', payload: { component: 'NetCounter', props: {} },
      } as never)
      const componentId = (mount.result as { componentId: string }).componentId
      expect(componentId).toBeTruthy()

      const received: Delta[] = []
      c.registerComponent(componentId, (m) => received.push(m as Delta))

      const res = await c.sendMessageAndWait({
        type: 'CALL_ACTION', componentId, action: 'increment', payload: { by: 7 },
      } as never)
      expect(res.success).toBe(true)
      expect(res.result).toBe(7)
      await until(() => received.some(m => m.type === 'STATE_DELTA' && m.payload?.delta?.count === 7))

      const text = 'linha 1\nlinha 2\r\nação ✓ "aspas"'
      const echo = await c.sendMessageAndWait({
        type: 'CALL_ACTION', componentId, action: 'echo', payload: { text },
      } as never)
      expect(echo.result).toBe(text)
      await until(() => received.some(m => m.type === 'STATE_DELTA' && m.payload?.delta?.text === text))

      c.disconnect()
      await until(() => hub?.size === 0)
    })
  }

  it('SSE: token forjado → 404', async () => {
    const { port } = await start()
    const res = await fetch(`http://127.0.0.1:${port}/api/live/sse/send`, {
      method: 'POST',
      headers: { 'x-live-session': 'f'.repeat(64), 'content-type': 'application/json' },
      body: '{"type":"PING"}',
    })
    expect(res.status).toBe(404)
  })

  it('HTTP: token forjado → 404 em send e poll', async () => {
    const { port } = await start()
    const headers = { 'x-live-session': 'forjado', 'content-type': 'application/json' }
    expect((await fetch(`http://127.0.0.1:${port}/api/live/http/send`, { method: 'POST', headers, body: '{}' })).status).toBe(404)
    expect((await fetch(`http://127.0.0.1:${port}/api/live/http/poll`, { headers })).status).toBe(404)
  })

  it('SSE: cliente que derruba a conexão libera a sessão', async () => {
    const { port, live } = await start()
    const ac = new AbortController()
    const res = await fetch(`http://127.0.0.1:${port}/api/live/sse`, { signal: ac.signal })
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)
    const first = new TextDecoder().decode((await res.body!.getReader().read()).value)
    expect(first).toMatch(/^event: session/)
    expect(live.sseHub?.size).toBe(1)
    ac.abort()
    await until(() => live.sseHub?.size === 0)
  })
})

describe('FastifyTransport — rotas cruas com corpo binário', () => {
  let app: FastifyInstance | null = null
  let hub: SseConnectionHub | HttpPollingHub | null = null

  afterEach(async () => {
    hub?.closeAll()
    hub = null
    app?.server.closeAllConnections?.()
    await app?.close()
    app = null
  })

  function recorder() {
    const messages: Array<{ message: unknown; isBinary: boolean }> = []
    const config: Omit<WebSocketConfig, 'path'> = {
      onOpen: () => {},
      onMessage: (_ws, message, isBinary) => { messages.push({ message, isBinary }) },
      onClose: () => {},
    }
    return { config, messages }
  }

  async function openSseToken(port: number, ac: AbortController): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${port}/api/live/sse`, { signal: ac.signal })
    const first = new TextDecoder().decode((await res.body!.getReader().read()).value)
    return /"token":"([0-9a-f]{64})"/.exec(first)![1]!
  }

  it('SSE: POST application/octet-stream chega cru (bytes idênticos, isBinary)', async () => {
    app = Fastify()
    const rec = recorder()
    const h = new SseConnectionHub(rec.config, { heartbeatMs: 0 })
    hub = h
    new FastifyTransport(app).registerRawRoutes(h.routes())
    const port = await listen(app)

    const ac = new AbortController()
    const token = await openSseToken(port, ac)
    // bytes que não são UTF-8 válido: qualquer decodificação em texto os corromperia
    const bytes = new Uint8Array(1024).map((_, i) => (i * 97 + 13) & 0xff)
    const res = await fetch(`http://127.0.0.1:${port}/api/live/sse/send`, {
      method: 'POST',
      headers: { 'x-live-session': token, 'content-type': 'application/octet-stream' },
      body: bytes,
    })
    expect(res.status).toBe(204)
    expect(rec.messages).toHaveLength(1)
    expect(rec.messages[0]!.isBinary).toBe(true)
    expect(new Uint8Array(rec.messages[0]!.message as ArrayBuffer)).toEqual(bytes)
    ac.abort()
  })

  it('HTTP: POST binário e JSON na mesma sessão chegam intactos', async () => {
    app = Fastify()
    const rec = recorder()
    const h = new HttpPollingHub(rec.config, { pollTimeoutMs: 200 })
    hub = h
    new FastifyTransport(app).registerRawRoutes(h.routes())
    const port = await listen(app)

    const { token } = await (await fetch(`http://127.0.0.1:${port}/api/live/http`)).json() as { token: string }
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0xc3])
    const bin = await fetch(`http://127.0.0.1:${port}/api/live/http/send`, {
      method: 'POST',
      headers: { 'x-live-session': token, 'content-type': 'application/octet-stream' },
      body: bytes,
    })
    expect(bin.status).toBe(204)
    const json = await fetch(`http://127.0.0.1:${port}/api/live/http/send`, {
      method: 'POST',
      headers: { 'x-live-session': token, 'content-type': 'application/json' },
      body: '{"type":"PING","t":"ação"}',
    })
    expect(json.status).toBe(204)
    expect(rec.messages[0]!.isBinary).toBe(true)
    expect(new Uint8Array(rec.messages[0]!.message as ArrayBuffer)).toEqual(bytes)
    expect(rec.messages[1]).toEqual({ message: '{"type":"PING","t":"ação"}', isBinary: false })
  })

  it('SSE backpressure pela rede: cliente TCP que para de ler → sessão fechada com 1008', async () => {
    app = Fastify()
    const closed: number[] = []
    const opened: GenericWebSocket[] = []
    const h = new SseConnectionHub({
      onOpen: (ws) => { opened.push(ws) }, onMessage: () => {}, onClose: (_ws, code) => { closed.push(code) },
    }, { heartbeatMs: 0, maxBufferedBytes: 64 * 1024 })
    hub = h
    new FastifyTransport(app).registerRawRoutes(h.routes())
    const port = await listen(app)

    // cliente "lento": abre o stream e para de ler o socket
    const CRLF = String.fromCharCode(13, 10)
    const sock = net.connect(port, '127.0.0.1')
    await new Promise<void>((r) => sock.once('connect', () => r()))
    sock.write(['GET /api/live/sse HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Accept: text/event-stream', '', ''].join(CRLF))
    await until(() => opened.length === 1)
    sock.pause()

    try {
      // servidor empurra até 256MB, um frame por vez; sem backpressure na ponte, tudo iria para a
      // memória do Node e a sessão nunca seria fechada
      const frame = 'x'.repeat(8 * 1024) // < maxBufferedBytes: só enche se a ponte parar de ler
      for (let i = 0; i < 32 * 1024 && opened[0]!.readyState === 1; i++) {
        opened[0]!.send(frame)
        await new Promise(r => setImmediate(r)) // dá tempo à ponte de escoar cada frame
      }
      await until(() => closed.length === 1)
      expect(closed[0]).toBe(1008)
      expect(h.size).toBe(0)
    } finally {
      sock.destroy()
    }
  }, 30_000)

  it('corpo acima do maxMessageSize → 413 pela rede', async () => {
    app = Fastify()
    const rec = recorder()
    const h = new SseConnectionHub(rec.config, { heartbeatMs: 0, maxMessageSize: 100 })
    hub = h
    new FastifyTransport(app).registerRawRoutes(h.routes())
    const port = await listen(app)

    const ac = new AbortController()
    const token = await openSseToken(port, ac)
    const res = await fetch(`http://127.0.0.1:${port}/api/live/sse/send`, {
      method: 'POST',
      headers: { 'x-live-session': token, 'content-type': 'application/octet-stream' },
      body: new Uint8Array(500),
    })
    expect(res.status).toBe(413)
    expect(rec.messages).toHaveLength(0)
    ac.abort()
  })
})
