// Bordas de segurança e robustez dos transportes SSE e HTTP long-polling
// (SseConnectionHub / HttpPollingHub), em memória: Request/Response padrão,
// sem porta de rede. Os hubs recebem um WebSocketConfig que só registra eventos.
import { describe, it, expect, afterEach } from 'vitest'
import { SseConnectionHub } from '../../transport/sse'
import { HttpPollingHub, type HttpPollResponse } from '../../transport/http-polling'
import type { GenericWebSocket, WebSocketConfig } from '../../transport/types'

const BASE = 'http://app.test'
const enc = new TextEncoder()
const dec = new TextDecoder()

/** WebSocketConfig que registra aberturas, mensagens e fechamentos. */
function recorder() {
  const opened: GenericWebSocket[] = []
  const messages: Array<{ ws: GenericWebSocket; message: unknown; isBinary: boolean }> = []
  const closed: Array<{ ws: GenericWebSocket; code: number; reason: string }> = []
  const config: Omit<WebSocketConfig, 'path'> = {
    onOpen: (ws) => { opened.push(ws) },
    onMessage: (ws, message, isBinary) => { messages.push({ ws, message, isBinary }) },
    onClose: (ws, code, reason) => { closed.push({ ws, code, reason }) },
  }
  return { config, opened, messages, closed }
}

const until = async (cond: () => boolean, ms = 3000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout esperando condição')
    await new Promise(r => setTimeout(r, 2))
  }
}

/** Lê o stream SSE em segundo plano, acumulando o texto. */
function readAll(res: Response) {
  const reader = res.body!.getReader()
  const state = { text: '', done: false }
  const finished = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        state.text += dec.decode(value, { stream: true })
      }
    } catch { /* cancelado */ }
    state.done = true
  })()
  return { state, reader, finished }
}

/** Abre um stream SSE e devolve o token (lido do primeiro evento). */
async function openSse(hub: SseConnectionHub, headers: Record<string, string> = {}) {
  const res = hub.handleStream(new Request(`${BASE}/api/live/sse`, { headers }))
  expect(res.status).toBe(200)
  const r = readAll(res)
  await until(() => r.state.text.includes('event: session'))
  const token = /"token":"([0-9a-f]{64})"/.exec(r.state.text)![1]!
  return { token, ...r }
}

function post(path: string, token: string, body: RequestInit['body'], headers: Record<string, string> = {}) {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'x-live-session': token, 'content-type': 'application/json', ...headers },
    body,
  })
}

/** Corpo que nunca termina (prova que o 413 por content-length não lê o corpo). */
function endlessBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(8)); return new Promise(() => {}) } })
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE
// ─────────────────────────────────────────────────────────────────────────────

describe('SseConnectionHub — bordas', () => {
  let hub: SseConnectionHub | null = null
  afterEach(() => { hub?.closeAll(); hub = null })

  it('POST acima de maxMessageSize via Content-Length → 413 sem ler o corpo', async () => {
    const rec = recorder()
    hub = new SseConnectionHub(rec.config, { heartbeatMs: 0, maxMessageSize: 64 })
    const { token } = await openSse(hub)
    const req = new Request(`${BASE}/api/live/sse/send`, {
      method: 'POST',
      headers: { 'x-live-session': token, 'content-type': 'application/json', 'content-length': '100000' },
      body: endlessBody(),
      duplex: 'half',
    } as RequestInit)
    const res = await hub.handleSend(req)
    expect(res.status).toBe(413)
    expect(rec.messages).toHaveLength(0)
  })

  it('POST acima de maxMessageSize SEM Content-Length (tamanho real) → 413', async () => {
    const rec = recorder()
    hub = new SseConnectionHub(rec.config, { heartbeatMs: 0, maxMessageSize: 64 })
    const { token } = await openSse(hub)
    const req = post('/api/live/sse/send', token, 'x'.repeat(65))
    expect(req.headers.get('content-length')).toBeNull()
    expect((await hub.handleSend(req)).status).toBe(413)
    expect(rec.messages).toHaveLength(0)

    // no limite exato ainda passa
    const ok = await hub.handleSend(post('/api/live/sse/send', token, 'y'.repeat(64)))
    expect(ok.status).toBe(204)
    expect(rec.messages).toHaveLength(1)
  })

  it('POST com Origin diferente da origem do stream → 403; mesma origem → 204', async () => {
    const rec = recorder()
    hub = new SseConnectionHub(rec.config, { heartbeatMs: 0 })
    const { token } = await openSse(hub, { origin: 'https://app.test' })
    const evil = await hub.handleSend(post('/api/live/sse/send', token, '{}', { origin: 'https://evil.test' }))
    expect(evil.status).toBe(403)
    expect(rec.messages).toHaveLength(0)
    const good = await hub.handleSend(post('/api/live/sse/send', token, '{}', { origin: 'https://app.test' }))
    expect(good.status).toBe(204)
    expect(rec.messages).toHaveLength(1)
  })

  it('backpressure: cliente que não consome passa de maxBufferedBytes → fecha com 1008', async () => {
    const rec = recorder()
    hub = new SseConnectionHub(rec.config, { heartbeatMs: 0, maxBufferedBytes: 256 })
    // abre o stream e NÃO lê o corpo
    const res = hub.handleStream(new Request(`${BASE}/api/live/sse`))
    const socket = rec.opened[0]!
    expect(hub.size).toBe(1)

    socket.send('a'.repeat(1024))
    expect(socket.readyState).toBe(3)
    expect(hub.size).toBe(0)
    expect(rec.closed).toHaveLength(1)
    expect(rec.closed[0]!.code).toBe(1008)
    expect(rec.closed[0]!.reason).toMatch(/backpressure/)

    // o stream termina com o evento close carregando o 1008
    const r = readAll(res)
    await r.finished
    expect(r.state.text).toMatch(/event: close\ndata: \{"code":1008/)

    // depois de fechado, envios são descartados e o token some
    socket.send('ignorado')
    const token = /"token":"([0-9a-f]{64})"/.exec(r.state.text)![1]!
    expect((await hub.handleSend(post('/api/live/sse/send', token, '{}'))).status).toBe(404)
  })

  it('cliente que consome não é derrubado mesmo mandando mais que maxBufferedBytes no total', async () => {
    const rec = recorder()
    hub = new SseConnectionHub(rec.config, { heartbeatMs: 0, maxBufferedBytes: 4096 })
    const { state } = await openSse(hub)
    const socket = rec.opened[0]!
    for (let i = 0; i < 20; i++) {
      socket.send(`{"i":${i},"pad":"${'p'.repeat(500)}"}`)
      await until(() => state.text.includes(`"i":${i},`))
    }
    expect(socket.readyState).toBe(1)
    expect(rec.closed).toHaveLength(0)
  })

  it('heartbeat emite `: ping` com heartbeatMs pequeno', async () => {
    const rec = recorder()
    hub = new SseConnectionHub(rec.config, { heartbeatMs: 15 })
    const { state } = await openSse(hub)
    await until(() => (state.text.match(/^: ping$/gm) ?? []).length >= 2)
  })

  it('heartbeat para quando não há mais conexões', async () => {
    const rec = recorder()
    hub = new SseConnectionHub(rec.config, { heartbeatMs: 10 })
    const { reader } = await openSse(hub)
    await reader.cancel()
    await until(() => hub!.size === 0)
    expect((hub as unknown as { heartbeat: unknown }).heartbeat).toBeNull()
  })

  it('frame binário vai como `event: binary` em base64 com os mesmos bytes', async () => {
    const rec = recorder()
    hub = new SseConnectionHub(rec.config, { heartbeatMs: 0 })
    const { state } = await openSse(hub)
    const bytes = new Uint8Array(300).map((_, i) => (i * 7) & 0xff)
    rec.opened[0]!.send(bytes)
    await until(() => state.text.includes('event: binary'))
    const b64 = /event: binary\ndata: (.*)\n\n/.exec(state.text)![1]!
    expect(new Uint8Array(Buffer.from(b64, 'base64'))).toEqual(bytes)
  })

  it('POST binário chega ao onMessage como ArrayBuffer com isBinary=true', async () => {
    const rec = recorder()
    hub = new SseConnectionHub(rec.config, { heartbeatMs: 0 })
    const { token } = await openSse(hub)
    const bytes = new Uint8Array([0, 255, 1, 254, 128])
    const res = await hub.handleSend(post('/api/live/sse/send', token, bytes, { 'content-type': 'application/octet-stream' }))
    expect(res.status).toBe(204)
    expect(rec.messages[0]!.isBinary).toBe(true)
    expect(new Uint8Array(rec.messages[0]!.message as ArrayBuffer)).toEqual(bytes)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// HTTP long-polling
// ─────────────────────────────────────────────────────────────────────────────

describe('HttpPollingHub — bordas', () => {
  let hub: HttpPollingHub | null = null
  afterEach(() => { hub?.closeAll(); hub = null })

  async function openHttp(h: HttpPollingHub, headers: Record<string, string> = {}) {
    const res = h.handleConnect(new Request(`${BASE}/api/live/http`, { headers }))
    expect(res.status).toBe(200)
    return ((await res.json()) as { token: string }).token
  }

  const pollReq = (token: string, headers: Record<string, string> = {}) =>
    new Request(`${BASE}/api/live/http/poll`, { headers: { 'x-live-session': token, ...headers } })

  const pollBody = async (p: Promise<Response>) => (await (await p).json()) as HttpPollResponse

  it('POST acima de maxMessageSize → 413 (Content-Length e tamanho real)', async () => {
    const rec = recorder()
    hub = new HttpPollingHub(rec.config, { maxMessageSize: 32 })
    const token = await openHttp(hub)
    const declared = new Request(`${BASE}/api/live/http/send`, {
      method: 'POST',
      headers: { 'x-live-session': token, 'content-length': '5000' },
      body: endlessBody(),
      duplex: 'half',
    } as RequestInit)
    expect((await hub.handleSend(declared)).status).toBe(413)

    const real = post('/api/live/http/send', token, 'z'.repeat(33))
    expect(real.headers.get('content-length')).toBeNull()
    expect((await hub.handleSend(real)).status).toBe(413)
    expect(rec.messages).toHaveLength(0)
  })

  it('Origin diferente → 403 em send, poll e close (e a sessão continua viva)', async () => {
    const rec = recorder()
    hub = new HttpPollingHub(rec.config, { pollTimeoutMs: 30 })
    const token = await openHttp(hub, { origin: 'https://app.test' })
    const evil = { origin: 'https://evil.test' }

    expect((await hub.handleSend(post('/api/live/http/send', token, '{}', evil))).status).toBe(403)
    expect((await hub.handlePoll(pollReq(token, evil))).status).toBe(403)
    const close = hub.handleClose(new Request(`${BASE}/api/live/http/close`, {
      method: 'POST', headers: { 'x-live-session': token, ...evil },
    }))
    expect(close.status).toBe(403)
    expect(hub.size).toBe(1)
    expect(rec.messages).toHaveLength(0)
    expect(rec.closed).toHaveLength(0)

    // a origem legítima continua funcionando
    expect((await hub.handleSend(post('/api/live/http/send', token, '{}', { origin: 'https://app.test' }))).status).toBe(204)
    expect((await hub.handlePoll(pollReq(token, { origin: 'https://app.test' }))).status).toBe(200)
  })

  it('backpressure: fila acima do teto sem poll → fecha com 1008 e descarta a fila', async () => {
    const rec = recorder()
    hub = new HttpPollingHub(rec.config, { maxBufferedBytes: 200 })
    const token = await openHttp(hub)
    const socket = rec.opened[0]!
    socket.send('a'.repeat(150))
    expect(socket.readyState).toBe(1)
    socket.send('b'.repeat(150)) // 300 > 200
    expect(socket.readyState).toBe(3)
    expect(rec.closed[0]).toMatchObject({ code: 1008 })
    expect(rec.closed[0]!.reason).toMatch(/backpressure/)
    expect(hub.size).toBe(0)
    expect((await hub.handlePoll(pollReq(token))).status).toBe(404)
  })

  it('poll novo substitui o pendente: o antigo responde vazio e nenhum frame se perde', async () => {
    const rec = recorder()
    hub = new HttpPollingHub(rec.config, { pollTimeoutMs: 5000 })
    const token = await openHttp(hub)
    const socket = rec.opened[0]!

    const first = hub.handlePoll(pollReq(token))
    await new Promise(r => setTimeout(r, 5))
    const second = hub.handlePoll(pollReq(token))

    // o antigo é liberado na hora, vazio (antes do timeout de 5s)
    const t0 = Date.now()
    expect(await pollBody(first)).toEqual({ frames: [] })
    expect(Date.now() - t0).toBeLessThan(1000)

    // frames enviados agora vão para o poll novo
    socket.send('{"n":1}')
    expect((await pollBody(second)).frames).toEqual([{ t: '{"n":1}' }])

    // frames enviados sem poll ficam na fila e saem, em ordem, no próximo
    socket.send('{"n":2}')
    socket.send('{"n":3}')
    expect((await pollBody(hub.handlePoll(pollReq(token)))).frames).toEqual([{ t: '{"n":2}' }, { t: '{"n":3}' }])
    expect(hub.size).toBe(1)
  })

  it('frame binário vai como { b: base64 } com os mesmos bytes', async () => {
    const rec = recorder()
    hub = new HttpPollingHub(rec.config, { pollTimeoutMs: 1000 })
    const token = await openHttp(hub)
    const bytes = new Uint8Array(1000).map((_, i) => (i * 31) & 0xff)
    rec.opened[0]!.send(bytes)
    const body = await pollBody(hub.handlePoll(pollReq(token)))
    expect(body.frames).toHaveLength(1)
    const frame = body.frames[0] as { b: string }
    expect(new Uint8Array(Buffer.from(frame.b, 'base64'))).toEqual(bytes)
  })

  it('close pelo servidor entrega o aviso ao poll pendente e /close é idempotente', async () => {
    const rec = recorder()
    hub = new HttpPollingHub(rec.config, { pollTimeoutMs: 5000 })
    const token = await openHttp(hub)
    const pending = hub.handlePoll(pollReq(token))
    rec.opened[0]!.send('{"ultimo":true}')
    // o poll já respondeu com o frame; outro fica pendente e recebe o close
    expect((await pollBody(pending)).frames).toEqual([{ t: '{"ultimo":true}' }])
    const next = hub.handlePoll(pollReq(token))
    rec.opened[0]!.close(4000, 'tchau')
    expect(await pollBody(next)).toEqual({ frames: [], closed: { code: 4000, reason: 'tchau' } })

    const closeReq = () => new Request(`${BASE}/api/live/http/close`, { method: 'POST', headers: { 'x-live-session': token } })
    expect(hub.handleClose(closeReq()).status).toBe(204)
    expect(hub.handleClose(closeReq()).status).toBe(204)
    expect(rec.closed).toHaveLength(1)
  })

  it('poll pendente não deixa a sessão expirar no sweep', async () => {
    const rec = recorder()
    hub = new HttpPollingHub(rec.config, { pollTimeoutMs: 5000, sessionTimeoutMs: 6000 })
    const token = await openHttp(hub)
    const pending = hub.handlePoll(pollReq(token))
    hub.sweep(Date.now() + 60_000)
    expect(hub.size).toBe(1)
    hub.closeAll()
    expect((await pollBody(pending)).closed?.code).toBe(1001)
  })
})
