// Transportes SSE e HTTP long-polling com Express REAL em porta de rede.
//
// LiveServer + ExpressTransport num http.createServer (porta 0) ⇄ LiveConnection
// real (transport 'sse' / 'http') usando o `fetch` global do Node. Exercita a
// ponte Node ⇄ Fetch (core/transport/node-bridge.ts) de ponta a ponta.

import { describe, it, expect, afterEach } from 'vitest'
import express from 'express'
import http from 'http'
import net, { type AddressInfo } from 'net'
import { LiveServer, LiveComponent, SseConnectionHub, HttpPollingHub } from '@fluxstack/live'
import type { GenericWebSocket, WebSocketConfig } from '@fluxstack/live'
import { LiveConnection } from '@fluxstack/live-client'
import { ExpressTransport } from '../index'

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

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

function closeHttp(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.()
    server.close(() => resolve())
  })
}

describe('ExpressTransport — SSE e HTTP em porta real', () => {
  let httpServer: http.Server | null = null
  let live: LiveServer | null = null
  let conn: LiveConnection | null = null
  /** corpos que o express.json() já tinha parseado quando o POST /send chegou na ponte */
  let parsedBodies: unknown[] = []

  afterEach(async () => {
    parsedBodies = []
    conn?.destroy()
    conn = null
    await live?.shutdown()
    live = null
    if (httpServer) await closeHttp(httpServer)
    httpServer = null
  })

  async function start(opts: { json?: boolean } = {}) {
    const app = express()
    // body-parser global registrado ANTES das rotas do live: consome o corpo JSON
    if (opts.json) {
      app.use(express.json())
      app.use((req, _res, next) => {
        if (req.path.endsWith('/send') && req.readableEnded) parsedBodies.push(req.body)
        next()
      })
    }
    httpServer = http.createServer(app)
    live = new LiveServer({
      transport: new ExpressTransport(app, httpServer),
      components: [NetCounter as never],
      httpPrefix: false,
      sse: { heartbeatMs: 0 },
      http: { pollTimeoutMs: 300 },
    })
    await live.start()
    const port = await listen(httpServer)
    return { port, live }
  }

  function connect(port: number, transport: 'sse' | 'http') {
    conn = new LiveConnection({
      url: `ws://127.0.0.1:${port}/api/live/ws`,
      transport,
      reconnectInterval: 50,
      heartbeatInterval: 60_000,
    })
    return conn
  }

  async function fullCycle(port: number, server: LiveServer, mode: 'sse' | 'http') {
    const c = connect(port, mode)
    await until(() => c.state.connected && !!c.state.connectionId)
    expect(c.state.transport).toBe(mode)
    const hub = mode === 'sse' ? server.sseHub : server.httpPollingHub
    expect(hub?.size).toBe(1)

    const mount = await c.sendMessageAndWait({
      type: 'COMPONENT_MOUNT', componentId: '', payload: { component: 'NetCounter', props: {} },
    } as never)
    const componentId = (mount.result as { componentId: string }).componentId
    expect(componentId).toBeTruthy()

    const received: Delta[] = []
    c.registerComponent(componentId, (m) => received.push(m as Delta))

    const res = await c.sendMessageAndWait({
      type: 'CALL_ACTION', componentId, action: 'increment', payload: { by: 4 },
    } as never)
    expect(res.success).toBe(true)
    expect(res.result).toBe(4)
    await until(() => received.some(m => m.type === 'STATE_DELTA' && m.payload?.delta?.count === 4))

    // texto multi-linha + unicode atravessa POST e stream intacto
    const text = 'linha 1\nlinha 2\r\nação ✓ "aspas"'
    const echo = await c.sendMessageAndWait({
      type: 'CALL_ACTION', componentId, action: 'echo', payload: { text },
    } as never)
    expect(echo.result).toBe(text)
    await until(() => received.some(m => m.type === 'STATE_DELTA' && m.payload?.delta?.text === text))

    // desconectar libera a sessão no servidor
    c.disconnect()
    await until(() => hub?.size === 0)
  }

  for (const mode of ['sse', 'http'] as const) {
    it(`${mode}: conecta, monta, action, recebe STATE_DELTA e desconectar libera a sessão`, async () => {
      const { port, live } = await start()
      await fullCycle(port, live, mode)
    })

    it(`${mode}: com app.use(express.json()) antes, o POST /send continua funcionando`, async () => {
      const { port, live } = await start({ json: true })
      await fullCycle(port, live, mode)
      // prova que o parser realmente consumiu o stream antes da ponte
      expect(parsedBodies.length).toBeGreaterThanOrEqual(3)
      expect(parsedBodies.some(b => (b as { type?: string }).type === 'CALL_ACTION')).toBe(true)
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
    const { port } = await start({ json: true })
    const headers = { 'x-live-session': 'forjado', 'content-type': 'application/json' }
    const send = await fetch(`http://127.0.0.1:${port}/api/live/http/send`, { method: 'POST', headers, body: '{}' })
    expect(send.status).toBe(404)
    const poll = await fetch(`http://127.0.0.1:${port}/api/live/http/poll`, { headers })
    expect(poll.status).toBe(404)
  })

  it('SSE: fechar o socket TCP do cliente (sem aviso) cancela o stream e libera a sessão', async () => {
    const { port, live } = await start()
    const ac = new AbortController()
    const res = await fetch(`http://127.0.0.1:${port}/api/live/sse`, { signal: ac.signal })
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)
    const reader = res.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toMatch(/^event: session/)
    expect(live.sseHub?.size).toBe(1)
    ac.abort()
    await until(() => live.sseHub?.size === 0)
  })
})

describe('ExpressTransport — rotas cruas com corpo binário', () => {
  let httpServer: http.Server | null = null
  let hub: SseConnectionHub | HttpPollingHub | null = null

  afterEach(async () => {
    hub?.closeAll()
    hub = null
    if (httpServer) await closeHttp(httpServer)
    httpServer = null
  })

  function recorder() {
    const messages: Array<{ message: unknown; isBinary: boolean }> = []
    const config: Omit<WebSocketConfig, 'path'> = {
      onOpen: (_ws: GenericWebSocket) => {},
      onMessage: (_ws, message, isBinary) => { messages.push({ message, isBinary }) },
      onClose: () => {},
    }
    return { config, messages }
  }

  it('POST application/octet-stream chega cru mesmo com express.json() global', async () => {
    const app = express()
    app.use(express.json())
    httpServer = http.createServer(app)
    const rec = recorder()
    const h = new HttpPollingHub(rec.config, { pollTimeoutMs: 200 })
    hub = h
    new ExpressTransport(app, httpServer).registerRawRoutes(h.routes())
    const port = await listen(httpServer)

    const { token } = await (await fetch(`http://127.0.0.1:${port}/api/live/http`)).json() as { token: string }
    const bytes = new Uint8Array(512).map((_, i) => (i * 3) & 0xff)
    const res = await fetch(`http://127.0.0.1:${port}/api/live/http/send`, {
      method: 'POST',
      headers: { 'x-live-session': token, 'content-type': 'application/octet-stream' },
      body: bytes,
    })
    expect(res.status).toBe(204)
    expect(rec.messages).toHaveLength(1)
    expect(rec.messages[0]!.isBinary).toBe(true)
    expect(new Uint8Array(rec.messages[0]!.message as ArrayBuffer)).toEqual(bytes)
  })

  it('SSE backpressure pela rede: cliente TCP que para de ler → sessão fechada com 1008', async () => {
    const app = express()
    httpServer = http.createServer(app)
    const closed: number[] = []
    const opened: GenericWebSocket[] = []
    const h = new SseConnectionHub({
      onOpen: (ws) => { opened.push(ws) }, onMessage: () => {}, onClose: (_ws, code) => { closed.push(code) },
    }, { heartbeatMs: 0, maxBufferedBytes: 64 * 1024 })
    hub = h
    new ExpressTransport(app, httpServer).registerRawRoutes(h.routes())
    const port = await listen(httpServer)

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

  it('POST chunked sem fim com token forjado → 404 na hora, sem bufferizar o corpo', async () => {
    const app = express()
    httpServer = http.createServer(app)
    const rec = recorder()
    const h = new SseConnectionHub(rec.config, { heartbeatMs: 0 })
    hub = h
    new ExpressTransport(app, httpServer).registerRawRoutes(h.routes())
    const port = await listen(httpServer)

    const CRLF = String.fromCharCode(13, 10)
    const sock = net.connect(port, '127.0.0.1')
    await new Promise<void>((r) => sock.once('connect', () => r()))
    let reply = ''
    sock.on('data', (d: Buffer) => { reply += d.toString('latin1') })
    sock.on('error', () => { /* servidor pode fechar */ })
    sock.write([
      'POST /api/live/sse/send HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Content-Type: application/json',
      'Transfer-Encoding: chunked', `x-live-session: ${'f'.repeat(64)}`, '', '',
    ].join(CRLF))
    // o cliente continua mandando chunks e nunca termina o corpo
    const chunk = 'x'.repeat(1024)
    const pump = setInterval(() => {
      if (!sock.destroyed) sock.write(`${chunk.length.toString(16)}${CRLF}${chunk}${CRLF}`)
    }, 5)
    try {
      await until(() => reply.includes(' 404 '), 3000)
      expect(reply.startsWith('HTTP/1.1 404')).toBe(true)
    } finally {
      clearInterval(pump)
      sock.destroy()
    }
  })

  it('corpo acima do maxMessageSize → 413 pela rede', async () => {
    const app = express()
    httpServer = http.createServer(app)
    const rec = recorder()
    const h = new SseConnectionHub(rec.config, { heartbeatMs: 0, maxMessageSize: 100 })
    hub = h
    new ExpressTransport(app, httpServer).registerRawRoutes(h.routes())
    const port = await listen(httpServer)

    const ac = new AbortController()
    const stream = await fetch(`http://127.0.0.1:${port}/api/live/sse`, { signal: ac.signal })
    const first = new TextDecoder().decode((await stream.body!.getReader().read()).value)
    const token = /"token":"([0-9a-f]{64})"/.exec(first)![1]!
    const res = await fetch(`http://127.0.0.1:${port}/api/live/sse/send`, {
      method: 'POST',
      headers: { 'x-live-session': token, 'content-type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(200) }),
    })
    expect(res.status).toBe(413)
    expect(rec.messages).toHaveLength(0)
    ac.abort()
  })
})
