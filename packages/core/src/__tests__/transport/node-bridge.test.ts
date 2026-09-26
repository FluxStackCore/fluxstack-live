// Testes unitários da ponte Node http ⇄ Fetch API (core/transport/node-bridge.ts),
// usada pelos adapters Express e Fastify para servir as rotas SSE/HTTP.
import { describe, it, expect } from 'vitest'
import {
  nodeToFetchRequest,
  writeFetchResponse,
  handleNodeWithFetch,
  type NodeRequestLike,
  type NodeResponseLike,
} from '../../transport/node-bridge'
import { SseConnectionHub } from '../../transport/sse'
import type { GenericWebSocket } from '../../transport/types'

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`não terminou em ${ms}ms`)), ms))])
}

/** IncomingMessage falso: corpo em chunks via async iterator. */
function fakeReq(init: {
  method?: string
  url?: string
  headers?: Record<string, string | string[] | undefined>
  chunks?: Array<Uint8Array | string>
  body?: unknown
  readableEnded?: boolean
  /** se true, iterar o corpo lança (prova que a ponte não tocou no stream) */
  forbidIteration?: boolean
}): NodeRequestLike & { iterated: boolean } {
  const req = {
    method: init.method,
    url: init.url,
    headers: init.headers ?? {},
    body: init.body,
    readableEnded: init.readableEnded,
    iterated: false,
    async *[Symbol.asyncIterator]() {
      req.iterated = true
      if (init.forbidIteration) throw new Error('o stream do corpo não devia ser lido')
      for (const c of init.chunks ?? []) yield c
    },
  }
  return req
}

/** ServerResponse falso que registra tudo e permite simular o 'close'. */
function fakeRes() {
  const listeners: Record<string, Array<() => void>> = {}
  const res = {
    /** valor devolvido por write() — false simula buffer do socket cheio */
    writeReturns: true,
    status: 0,
    headers: {} as Record<string, string>,
    writes: [] as Uint8Array[],
    ended: false,
    endChunk: undefined as Uint8Array | string | undefined,
    flushed: false,
    onWrite: null as null | ((chunk: Uint8Array) => void),
    writeHead(status: number, headers: Record<string, string>) { res.status = status; res.headers = headers },
    write(chunk: Uint8Array) { res.writes.push(chunk); res.onWrite?.(chunk); return res.writeReturns },
    end(chunk?: Uint8Array | string) { res.ended = true; res.endChunk = chunk },
    on(event: string, listener: () => void) { (listeners[event] ??= []).push(listener) },
    flushHeaders() { res.flushed = true },
    /** cliente foi embora (socket fechado) */
    emitClose() { for (const l of listeners.close ?? []) l() },
    /** socket esvaziou o buffer */
    emitDrain() { for (const l of listeners.drain ?? []) l() },
    listenerCount(event: string) { return (listeners[event] ?? []).length },
  }
  return res satisfies NodeResponseLike
}

const enc = new TextEncoder()
const dec = new TextDecoder()

const until = async (cond: () => boolean, ms = 2000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout esperando condição')
    await new Promise(r => setTimeout(r, 2))
  }
}

describe('nodeToFetchRequest', () => {
  it('copia headers, juntando valores múltiplos e ignorando undefined', async () => {
    const req = await nodeToFetchRequest(fakeReq({
      method: 'GET',
      url: '/x',
      headers: {
        host: 'app.test:8080',
        'x-multi': ['a', 'b'],
        'x-single': 'um',
        'x-undef': undefined,
      },
    }))
    expect(req.headers.get('x-multi')).toBe('a, b')
    expect(req.headers.get('x-single')).toBe('um')
    expect(req.headers.has('x-undef')).toBe(false)
  })

  it('monta a URL a partir do header host (com path e query)', async () => {
    const req = await nodeToFetchRequest(fakeReq({
      method: 'GET',
      url: '/api/live/http/poll?a=1',
      headers: { host: 'app.test:8080' },
    }))
    const url = new URL(req.url)
    expect(url.host).toBe('app.test:8080')
    expect(url.pathname).toBe('/api/live/http/poll')
    expect(url.searchParams.get('a')).toBe('1')
  })

  it('sem host usa a origem padrão (ou a informada)', async () => {
    expect(new URL((await nodeToFetchRequest(fakeReq({ url: '/p' }))).url).origin).toBe('http://localhost')
    const custom = await nodeToFetchRequest(fakeReq({ url: '/p' }), 'http://fallback.test:9')
    expect(new URL(custom.url).origin).toBe('http://fallback.test:9')
    expect(custom.method).toBe('GET') // método ausente → GET
  })

  it('GET/HEAD não têm corpo e não leem o stream', async () => {
    const r = fakeReq({ method: 'GET', url: '/', forbidIteration: true })
    const req = await nodeToFetchRequest(r)
    expect(req.body).toBeNull()
    expect(r.iterated).toBe(false)

    const h = fakeReq({ method: 'HEAD', url: '/', forbidIteration: true })
    expect((await nodeToFetchRequest(h)).body).toBeNull()
  })

  it('POST lê o stream cru, concatenando chunks string e binários', async () => {
    const req = await nodeToFetchRequest(fakeReq({
      method: 'POST',
      url: '/send',
      headers: { host: 'h' },
      chunks: ['{"type":', enc.encode('"PING"'), '}'],
    }))
    expect(await req.text()).toBe('{"type":"PING"}')
  })

  it('POST binário chega byte a byte', async () => {
    const bytes = new Uint8Array(256).map((_, i) => i)
    const req = await nodeToFetchRequest(fakeReq({
      method: 'POST',
      url: '/send',
      chunks: [bytes.subarray(0, 100), bytes.subarray(100)],
    }))
    expect(new Uint8Array(await req.arrayBuffer())).toEqual(bytes)
  })

  it('corpo já parseado como objeto (express.json) é reconstruído como JSON', async () => {
    const r = fakeReq({
      method: 'POST',
      url: '/send',
      body: { type: 'CALL_ACTION', payload: { texto: 'ação ✓' } },
      readableEnded: true,
      forbidIteration: true,
    })
    const req = await nodeToFetchRequest(r)
    expect(JSON.parse(await req.text())).toEqual({ type: 'CALL_ACTION', payload: { texto: 'ação ✓' } })
    expect(r.iterated).toBe(false)
  })

  it('corpo já parseado como string (express.text) é usado como está', async () => {
    const req = await nodeToFetchRequest(fakeReq({
      method: 'POST', url: '/send', body: 'linha 1\nlinha 2', readableEnded: true, forbidIteration: true,
    }))
    expect(await req.text()).toBe('linha 1\nlinha 2')
  })

  it('corpo já parseado como Buffer (express.raw) preserva os bytes', async () => {
    const buf = Buffer.from([0, 1, 2, 250, 255])
    const req = await nodeToFetchRequest(fakeReq({
      method: 'POST', url: '/send', body: buf, readableEnded: true, forbidIteration: true,
    }))
    expect(new Uint8Array(await req.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 250, 255]))
  })

  it('req.body presente mas stream NÃO consumido (parser não casou o content-type) → lê o stream', async () => {
    // express.json() define req.body = {} mesmo quando não parseia (ex.: octet-stream)
    const req = await nodeToFetchRequest(fakeReq({
      method: 'POST', url: '/send', body: {}, readableEnded: false, chunks: [new Uint8Array([9, 8, 7])],
    }))
    expect(new Uint8Array(await req.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]))
  })
})

describe('writeFetchResponse', () => {
  it('escreve status e headers e encerra quando não há corpo', async () => {
    const res = fakeRes()
    await writeFetchResponse(res, new Response(null, { status: 204, headers: { 'x-a': '1' } }))
    expect(res.status).toBe(204)
    expect(res.headers['x-a']).toBe('1')
    expect(res.flushed).toBe(true)
    expect(res.writes).toEqual([])
    expect(res.ended).toBe(true)
  })

  it('faz streaming chunk a chunk (não bufferiza a resposta inteira)', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
    const res = fakeRes()
    const done = writeFetchResponse(res, new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))

    // headers saem antes de qualquer dado (SSE precisa disso)
    await until(() => res.status === 200)
    expect(res.headers['content-type']).toBe('text/event-stream')
    expect(res.writes.length).toBe(0)

    controller.enqueue(enc.encode('event: a\n\n'))
    await until(() => res.writes.length === 1)
    expect(res.ended).toBe(false)

    controller.enqueue(enc.encode('event: b\n\n'))
    await until(() => res.writes.length === 2)
    expect(res.writes.map(w => dec.decode(w))).toEqual(['event: a\n\n', 'event: b\n\n'])
    expect(res.ended).toBe(false)

    controller.close()
    await done
    expect(res.ended).toBe(true)
  })

  it('cliente desconectando cancela o ReadableStream (dispara cancel()) e não chama end()', async () => {
    let cancelled = false
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start(c) { controller = c },
      cancel() { cancelled = true },
    })
    const res = fakeRes()
    const done = writeFetchResponse(res, new Response(stream))
    controller.enqueue(enc.encode('x'))
    await until(() => res.writes.length === 1)

    res.emitClose()
    await done // o laço termina sozinho: reader.read() resolve done após o cancel
    expect(cancelled).toBe(true)
    expect(res.ended).toBe(false)
    // nada mais é escrito depois da desconexão
    try { controller.enqueue(enc.encode('y')) } catch { /* stream já cancelado */ }
    await new Promise(r => setTimeout(r, 10))
    expect(res.writes.length).toBe(1)
  })

  it('respeita o backpressure do socket: write() === false pausa a leitura até o drain', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) { for (let i = 0; i < 4; i++) c.enqueue(enc.encode(`c${i}`)); c.close() },
    })
    const res = fakeRes()
    res.writeReturns = false
    const done = writeFetchResponse(res, new Response(stream))

    await until(() => res.writes.length === 1)
    await new Promise(r => setTimeout(r, 20))
    expect(res.writes.length).toBe(1) // parou: esperando o drain

    res.emitDrain()
    await until(() => res.writes.length === 2)
    await new Promise(r => setTimeout(r, 20))
    expect(res.writes.length).toBe(2)

    res.writeReturns = true
    res.emitDrain()
    await done
    expect(res.writes.map(w => dec.decode(w))).toEqual(['c0', 'c1', 'c2', 'c3'])
    expect(res.ended).toBe(true)
    // um único listener de drain, não um por write
    expect(res.listenerCount('drain')).toBeLessThanOrEqual(1)
  })

  it('cliente desconectando enquanto espera o drain encerra o laço e cancela o stream', async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(enc.encode('a')); c.enqueue(enc.encode('b')) },
      cancel() { cancelled = true },
    })
    const res = fakeRes()
    res.writeReturns = false
    const done = writeFetchResponse(res, new Response(stream))
    await until(() => res.writes.length === 1)
    res.emitClose()
    await done
    expect(cancelled).toBe(true)
    expect(res.writes.length).toBe(1)
    expect(res.ended).toBe(false)
  })

  it('stream que falha no meio não derruba a ponte e encerra a resposta', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
    const res = fakeRes()
    const done = writeFetchResponse(res, new Response(stream))
    controller.enqueue(enc.encode('a'))
    await until(() => res.writes.length === 1)
    controller.error(new Error('boom'))
    await expect(done).resolves.toBeUndefined()
    expect(res.ended).toBe(true)
  })
})

describe('handleNodeWithFetch', () => {
  /** request Node cujo corpo nunca termina (cliente malicioso mandando chunked sem fim) */
  function endlessReq(headers: Record<string, string>) {
    const state = { chunks: 0 }
    const req: NodeRequestLike = {
      method: 'POST',
      url: '/api/live/sse/send',
      headers: { host: 'h', 'content-type': 'application/json', ...headers },
      async *[Symbol.asyncIterator]() {
        for (;;) {
          state.chunks++
          yield new Uint8Array(1024)
          await new Promise(r => setTimeout(r, 0))
        }
      },
    }
    return { req, state }
  }

  it('não lê o corpo inteiro antes do handler: POST sem sessão válida → 404 sem bufferizar', async () => {
    const hub = new SseConnectionHub({ onOpen() {}, onMessage() {}, onClose() {} }, { heartbeatMs: 0 })
    const { req, state } = endlessReq({ 'x-live-session': 'forjado' })
    const res = fakeRes()
    await withTimeout(handleNodeWithFetch(req, res, (r) => hub.handleSend(r)), 2000)
    expect(res.status).toBe(404)
    expect(state.chunks).toBeLessThan(64)
  })

  it('sessão válida + corpo sem Content-Length que nunca acaba → 413 ao passar do limite', async () => {
    const opened: GenericWebSocket[] = []
    const hub = new SseConnectionHub({ onOpen(ws) { opened.push(ws) }, onMessage() {}, onClose() {} }, { heartbeatMs: 0, maxMessageSize: 8 * 1024 })
    const stream = hub.handleStream(new Request('http://h/api/live/sse'))
    const first = dec.decode((await stream.body!.getReader().read()).value)
    const token = /"token":"([0-9a-f]{64})"/.exec(first)![1]!
    const { req, state } = endlessReq({ 'x-live-session': token })
    const res = fakeRes()
    await withTimeout(handleNodeWithFetch(req, res, (r) => hub.handleSend(r)), 2000)
    expect(res.status).toBe(413)
    expect(state.chunks).toBeLessThan(64)
    hub.closeAll()
  })

  it('converte a request, chama o handler e escreve a resposta', async () => {
    const res = fakeRes()
    let seen: Request | null = null
    await handleNodeWithFetch(
      fakeReq({ method: 'POST', url: '/echo', headers: { host: 'h', 'content-type': 'text/plain' }, chunks: ['olá'] }),
      res,
      async (req) => { seen = req; return new Response(`eco:${await req.text()}`, { status: 201 }) },
    )
    expect(seen!.method).toBe('POST')
    expect(res.status).toBe(201)
    expect(dec.decode(Buffer.concat(res.writes))).toBe('eco:olá')
    expect(res.ended).toBe(true)
  })
})
