// @fluxstack/live-client - Transportes modulares
//
// O `LiveConnection` não conhece WebSocket nem SSE: ele fala com um
// `ClientTransport`. Cada transporte entrega frames de texto (JSON) ou binários
// e reporta abertura/fechamento. Reconexão, heartbeat, request/response e
// roteamento continuam no LiveConnection — iguais para qualquer transporte.
//
//   websocket  → full-duplex nativo (padrão)
//   sse        → servidor→cliente via Server-Sent Events (stream HTTP);
//                cliente→servidor via POST HTTP. Passa por proxies/firewalls
//                que bloqueiam WebSocket, funciona em HTTP/2 e serverless.
//   custom     → qualquer `ClientTransportFactory`.

/** Callbacks que o LiveConnection registra no transporte. */
export interface ClientTransportHandlers {
  onOpen(): void
  /** frame recebido: string = JSON, ArrayBuffer = frame binário */
  onMessage(data: string | ArrayBuffer): void
  onClose(code: number, reason: string): void
  onError(error: Error): void
}

export type ClientTransportKind = 'websocket' | 'sse' | 'http' | (string & {})

/** Contrato de um transporte do lado do cliente. */
export interface ClientTransport {
  readonly kind: ClientTransportKind
  /** pronto para enviar */
  readonly isOpen: boolean
  /** abertura em andamento */
  readonly isConnecting: boolean
  /** inicia a conexão; os eventos chegam pelos handlers */
  open(handlers: ClientTransportHandlers): void
  /** envia um frame (texto JSON ou binário). Lança se não estiver aberto. */
  send(data: string | ArrayBuffer): void
  /** fecha a conexão. Deve disparar `onClose` uma única vez. */
  close(code?: number, reason?: string): void
}

/** Endpoints resolvidos para o transporte. */
export interface ClientTransportEndpoints {
  /** URL WebSocket (ws:// ou wss://) */
  wsUrl: string
  /** URL base SSE (http:// ou https://) — stream em GET `sseUrl`, envio em POST `${sseUrl}/send` */
  sseUrl: string
  /** URL base HTTP long-polling — sessão em GET `httpUrl`, poll em `/poll`, envio em POST `/send` */
  httpUrl: string
}

export type ClientTransportFactory = (endpoints: ClientTransportEndpoints) => ClientTransport

/** Opção aceita pelo LiveConnection / Providers. */
/** Transportes embutidos. */
export type ClientTransportMode = 'websocket' | 'sse' | 'http'

/**
 * Opção de transporte:
 *  - um modo: 'websocket' | 'sse' | 'http'
 *  - 'auto' = ['websocket', 'sse', 'http']
 *  - uma LISTA em ordem de preferência (ex.: ['sse', 'http']): começa no primeiro
 *    e desce para o próximo se o atual nunca conseguir abrir
 *  - uma fábrica custom
 */
export type ClientTransportOption =
  | ClientTransportMode
  | 'auto'
  | readonly ClientTransportMode[]
  | ClientTransportFactory

/** Normaliza a opção numa cadeia de fallback (fábrica custom = cadeia de 1). */
export function resolveTransportChain(option: ClientTransportOption): ReadonlyArray<ClientTransportMode | ClientTransportFactory> {
  if (typeof option === 'function') return [option]
  if (option === 'auto') return ['websocket', 'sse', 'http']
  if (typeof option === 'string') return [option]
  if (option.length === 0) throw new Error('transport: lista vazia')
  return option
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket
// ─────────────────────────────────────────────────────────────────────────────

export class WebSocketClientTransport implements ClientTransport {
  readonly kind = 'websocket' as const
  private ws: WebSocket | null = null
  private closedReported = false

  constructor(private readonly url: string) {}

  get isOpen(): boolean { return this.ws?.readyState === WebSocket.OPEN }
  get isConnecting(): boolean { return this.ws?.readyState === WebSocket.CONNECTING }

  /** WebSocket nativo (compat com `getWebSocket()`). */
  get socket(): WebSocket | null { return this.ws }

  open(handlers: ClientTransportHandlers): void {
    const ws = new WebSocket(this.url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    this.closedReported = false
    ws.onopen = () => handlers.onOpen()
    ws.onmessage = (event: MessageEvent) => handlers.onMessage(event.data as string | ArrayBuffer)
    ws.onerror = () => handlers.onError(new Error('WebSocket connection error'))
    ws.onclose = (event: CloseEvent) => {
      if (this.closedReported) return
      this.closedReported = true
      handlers.onClose(event.code, event.reason)
    }
  }

  send(data: string | ArrayBuffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('WebSocket is not connected')
    this.ws.send(data)
  }

  close(code?: number, reason?: string): void {
    this.ws?.close(code, reason)
    this.ws = null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE + HTTP POST
// ─────────────────────────────────────────────────────────────────────────────

/** Header com o token de sessão SSE (enviado em cada POST). */
export const SSE_SESSION_HEADER = 'X-Live-Session'

export interface SseClientTransportOptions {
  /** `fetch` a usar (testes / runtimes sem fetch global). */
  fetch?: typeof fetch
  /** Envia cookies em origens cruzadas. Default: 'same-origin'. */
  credentials?: RequestCredentials
  /**
   * Tempo máximo até o evento `session` chegar. Proxies que bufferizam SSE
   * seguram o stream e ele "abre" sem nunca entregar nada — isso conta como
   * falha (no modo 'auto' o cliente então desce para HTTP). Default: 10000ms.
   */
  openTimeoutMs?: number
}

interface SseEvent { event: string; data: string }

/**
 * Parser incremental de `text/event-stream` (WHATWG). Aceita \n, \r\n e \r;
 * ignora comentários (`: ping`) e junta múltiplas linhas `data:`.
 */
export class SseParser {
  private buffer = ''
  private event = ''
  private data: string[] = []

  push(chunk: string): SseEvent[] {
    this.buffer += chunk
    const out: SseEvent[] = []
    let idx: number
    // processa linha a linha, mantendo a última linha incompleta no buffer
    while ((idx = this.buffer.search(/\r\n|\r|\n/)) !== -1) {
      const line = this.buffer.slice(0, idx)
      const sepLen = this.buffer.startsWith('\r\n', idx) ? 2 : 1
      // "\r" no fim do buffer pode ser metade de "\r\n": espera o próximo chunk
      if (this.buffer[idx] === '\r' && idx + 1 === this.buffer.length) break
      this.buffer = this.buffer.slice(idx + sepLen)
      if (line === '') {
        if (this.data.length > 0) out.push({ event: this.event || 'message', data: this.data.join('\n') })
        this.event = ''
        this.data = []
        continue
      }
      if (line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      let value = colon === -1 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'event') this.event = value
      else if (field === 'data') this.data.push(value)
    }
    return out
  }
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes.buffer
}

/**
 * Transporte SSE: o servidor empurra frames num stream `text/event-stream`;
 * o cliente envia cada frame num POST para `${sseUrl}/send`, com o token de
 * sessão recebido no primeiro evento (`event: session`).
 *
 * Usa `fetch` com stream (não `EventSource`) para: controlar a reconexão (fica
 * com o LiveConnection, que re-hidrata componentes), rodar em Bun/Node e ler o
 * status HTTP.
 */
export class SseClientTransport implements ClientTransport {
  readonly kind = 'sse' as const
  private readonly fetchFn: typeof fetch
  private readonly credentials: RequestCredentials
  private controller: AbortController | null = null
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private token: string | null = null
  private state: 'idle' | 'connecting' | 'open' | 'closed' = 'idle'
  private handlers: ClientTransportHandlers | null = null
  /** fila de envios: POSTs saem em ordem, um de cada vez */
  private sendChain: Promise<void> = Promise.resolve()
  private readonly openTimeoutMs: number
  private openTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly sseUrl: string, options: SseClientTransportOptions = {}) {
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.credentials = options.credentials ?? 'same-origin'
    this.openTimeoutMs = options.openTimeoutMs ?? 10000
  }

  get isOpen(): boolean { return this.state === 'open' }
  get isConnecting(): boolean { return this.state === 'connecting' }

  open(handlers: ClientTransportHandlers): void {
    this.handlers = handlers
    this.state = 'connecting'
    this.controller = new AbortController()
    if (this.openTimeoutMs > 0) {
      this.openTimer = setTimeout(() => {
        if (this.state === 'connecting') this.close(1006, 'SSE open timeout (stream bufferizado?)')
      }, this.openTimeoutMs)
    }
    void this.readStream(this.controller.signal)
  }

  private async readStream(signal: AbortSignal): Promise<void> {
    let code = 1006
    let reason = 'SSE stream ended'
    try {
      const res = await this.fetchFn(this.sseUrl, {
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
        credentials: this.credentials,
        cache: 'no-store',
        signal,
      })
      if (!res.ok || !res.body) {
        // 403 = origem rejeitada (mesmo código de fechamento do WebSocket)
        code = res.status === 403 ? 4003 : 1006
        reason = `SSE HTTP ${res.status}`
        this.handlers?.onError(new Error(reason))
        return
      }
      const reader = res.body.getReader()
      this.reader = reader
      const decoder = new TextDecoder()
      const parser = new SseParser()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        for (const ev of parser.push(decoder.decode(value, { stream: true }))) {
          const closed = this.dispatch(ev)
          if (closed) { code = closed.code; reason = closed.reason; return }
        }
      }
    } catch (err) {
      if (signal.aborted) { code = 1000; reason = 'Client closed' }
      else this.handlers?.onError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      this.finish(code, reason)
    }
  }

  /** Trata um evento SSE. Retorna o código/motivo se o servidor pediu para fechar. */
  private dispatch(ev: SseEvent): { code: number; reason: string } | null {
    switch (ev.event) {
      case 'session': {
        const parsed = JSON.parse(ev.data) as { token?: unknown }
        if (typeof parsed.token !== 'string') throw new Error('Invalid SSE session event')
        this.token = parsed.token
        if (this.openTimer) { clearTimeout(this.openTimer); this.openTimer = null }
        this.state = 'open'
        this.handlers?.onOpen()
        return null
      }
      case 'message':
        this.handlers?.onMessage(ev.data)
        return null
      case 'binary':
        this.handlers?.onMessage(base64ToArrayBuffer(ev.data))
        return null
      case 'close': {
        let code = 1000
        let reason = 'Server closed'
        try {
          const info = JSON.parse(ev.data) as { code?: unknown; reason?: unknown }
          if (typeof info.code === 'number') code = info.code
          if (typeof info.reason === 'string') reason = info.reason
        } catch { /* corpo inválido: mantém o padrão */ }
        return { code, reason }
      }
      default:
        return null
    }
  }

  send(data: string | ArrayBuffer): void {
    if (this.state !== 'open' || !this.token) throw new Error('SSE transport is not connected')
    const token = this.token
    const isBinary = typeof data !== 'string'
    this.sendChain = this.sendChain.then(async () => {
      if (this.state !== 'open') return
      try {
        const res = await this.fetchFn(`${this.sseUrl}/send`, {
          method: 'POST',
          headers: {
            'Content-Type': isBinary ? 'application/octet-stream' : 'application/json',
            [SSE_SESSION_HEADER]: token,
          },
          body: data,
          credentials: this.credentials,
        })
        // sessão expirou / servidor reiniciou → fecha para o LiveConnection reconectar
        if (res.status === 401 || res.status === 404 || res.status === 410) {
          this.close(1006, `SSE session lost (HTTP ${res.status})`)
        } else if (!res.ok) {
          this.handlers?.onError(new Error(`SSE send failed: HTTP ${res.status}`))
        }
      } catch (err) {
        this.handlers?.onError(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  close(code = 1000, reason = 'Client closed'): void {
    if (this.state === 'closed' || this.state === 'idle') return
    this.controller?.abort()
    // cancelar o leitor também encerra o stream do lado do servidor
    // (alguns runtimes não propagam o abort do fetch para o corpo)
    this.reader?.cancel().catch(() => { /* já encerrado */ })
    this.finish(code, reason)
  }

  private finish(code: number, reason: string): void {
    if (this.state === 'closed') return
    this.state = 'closed'
    if (this.openTimer) { clearTimeout(this.openTimer); this.openTimer = null }
    this.token = null
    this.controller = null
    this.reader = null
    const h = this.handlers
    this.handlers = null
    h?.onClose(code, reason)
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// HTTP puro (long-polling + POST)
// ─────────────────────────────────────────────────────────────────────────────

/** Frame no corpo do poll: texto JSON ou binário em base64. */
type HttpPollFrame = { t: string } | { b: string }

function readPollBody(body: unknown): { frames: HttpPollFrame[]; closed?: { code: number; reason: string } } {
  if (typeof body !== 'object' || body === null) throw new Error('Invalid poll response')
  const rec = body as Record<string, unknown>
  const rawFrames = Array.isArray(rec.frames) ? rec.frames : []
  const frames: HttpPollFrame[] = []
  for (const f of rawFrames) {
    if (typeof f !== 'object' || f === null) continue
    const fr = f as Record<string, unknown>
    if (typeof fr.t === 'string') frames.push({ t: fr.t })
    else if (typeof fr.b === 'string') frames.push({ b: fr.b })
  }
  let closed: { code: number; reason: string } | undefined
  if (typeof rec.closed === 'object' && rec.closed !== null) {
    const c = rec.closed as Record<string, unknown>
    closed = { code: typeof c.code === 'number' ? c.code : 1000, reason: typeof c.reason === 'string' ? c.reason : '' }
  }
  return closed ? { frames, closed } : { frames }
}

export interface HttpPollingClientTransportOptions {
  /** `fetch` a usar (testes / runtimes sem fetch global). */
  fetch?: typeof fetch
  /** Envia cookies em origens cruzadas. Default: 'same-origin'. */
  credentials?: RequestCredentials
}

/**
 * Transporte HTTP puro: abre a sessão com `GET httpUrl`, recebe por long-poll
 * (`GET httpUrl/poll`, que o servidor segura até ter frames) e envia por
 * `POST httpUrl/send`. Só requisições HTTP comuns — o último recurso quando
 * nem WebSocket nem SSE passam (mesma ideia do polling do Engine.IO/Socket.IO).
 */
export class HttpPollingClientTransport implements ClientTransport {
  readonly kind = 'http' as const
  private readonly fetchFn: typeof fetch
  private readonly credentials: RequestCredentials
  private controller: AbortController | null = null
  private token: string | null = null
  private state: 'idle' | 'connecting' | 'open' | 'closed' = 'idle'
  private handlers: ClientTransportHandlers | null = null
  private sendChain: Promise<void> = Promise.resolve()

  constructor(private readonly httpUrl: string, options: HttpPollingClientTransportOptions = {}) {
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.credentials = options.credentials ?? 'same-origin'
  }

  get isOpen(): boolean { return this.state === 'open' }
  get isConnecting(): boolean { return this.state === 'connecting' }

  open(handlers: ClientTransportHandlers): void {
    this.handlers = handlers
    this.state = 'connecting'
    this.controller = new AbortController()
    void this.run(this.controller.signal)
  }

  private async run(signal: AbortSignal): Promise<void> {
    let code = 1006
    let reason = 'HTTP polling ended'
    try {
      const res = await this.fetchFn(this.httpUrl, {
        method: 'GET',
        credentials: this.credentials,
        cache: 'no-store',
        signal,
      })
      if (!res.ok) {
        code = res.status === 403 ? 4003 : 1006
        reason = `HTTP connect ${res.status}`
        this.handlers?.onError(new Error(reason))
        return
      }
      const body = (await res.json()) as { token?: unknown }
      if (typeof body.token !== 'string') throw new Error('Invalid HTTP polling session')
      this.token = body.token
      this.state = 'open'
      this.handlers?.onOpen()

      // laço de long-poll: cada resposta traz os frames acumulados
      while (this.state === 'open') {
        const poll = await this.fetchFn(`${this.httpUrl}/poll`, {
          method: 'GET',
          headers: { [SSE_SESSION_HEADER]: this.token },
          credentials: this.credentials,
          cache: 'no-store',
          signal,
        })
        if (poll.status === 404 || poll.status === 410 || poll.status === 401) {
          reason = `HTTP polling session lost (${poll.status})`
          return
        }
        if (!poll.ok) {
          reason = `HTTP poll ${poll.status}`
          this.handlers?.onError(new Error(reason))
          return
        }
        const { frames, closed } = readPollBody(await poll.json())
        for (const f of frames) {
          if (this.state !== 'open') break
          this.handlers?.onMessage('t' in f ? f.t : base64ToArrayBuffer(f.b))
        }
        if (closed) { code = closed.code; reason = closed.reason || 'Server closed'; return }
      }
    } catch (err) {
      if (signal.aborted) { code = 1000; reason = 'Client closed' }
      else this.handlers?.onError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      this.finish(code, reason)
    }
  }

  send(data: string | ArrayBuffer): void {
    if (this.state !== 'open' || !this.token) throw new Error('HTTP transport is not connected')
    const token = this.token
    const isBinary = typeof data !== 'string'
    this.sendChain = this.sendChain.then(async () => {
      if (this.state !== 'open') return
      try {
        const res = await this.fetchFn(`${this.httpUrl}/send`, {
          method: 'POST',
          headers: {
            'Content-Type': isBinary ? 'application/octet-stream' : 'application/json',
            [SSE_SESSION_HEADER]: token,
          },
          body: data,
          credentials: this.credentials,
        })
        if (res.status === 401 || res.status === 404 || res.status === 410) {
          this.close(1006, `HTTP session lost (HTTP ${res.status})`)
        } else if (!res.ok) {
          this.handlers?.onError(new Error(`HTTP send failed: HTTP ${res.status}`))
        }
      } catch (err) {
        this.handlers?.onError(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  close(code = 1000, reason = 'Client closed'): void {
    if (this.state === 'closed' || this.state === 'idle') return
    // Avisa o servidor: abortar o poll não chega até ele. `keepalive` deixa a
    // requisição sair mesmo se a aba estiver fechando.
    const token = this.token
    if (token) {
      this.fetchFn(`${this.httpUrl}/close`, {
        method: 'POST',
        headers: { [SSE_SESSION_HEADER]: token },
        credentials: this.credentials,
        keepalive: true,
      }).catch(() => { /* servidor fora do ar: a sessão expira sozinha */ })
    }
    this.controller?.abort()
    this.finish(code, reason)
  }

  private finish(code: number, reason: string): void {
    if (this.state === 'closed') return
    this.state = 'closed'
    this.token = null
    this.controller = null
    const h = this.handlers
    this.handlers = null
    h?.onClose(code, reason)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolução de endpoints e fábrica
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deriva as URLs. `url` (WebSocket) e `sseUrl` podem ser informadas; o que
 * faltar é derivado: `ws(s)://host/api/live/ws` ⇄ `http(s)://host/api/live/sse`.
 */
export function resolveTransportEndpoints(url?: string, sseUrl?: string, httpUrl?: string): ClientTransportEndpoints {
  const hasWindow = typeof window !== 'undefined' && !!window.location
  const wsUrl = url ?? (hasWindow
    ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/api/live/ws`
    : 'ws://localhost:3000/api/live/ws')
  const derivedSse = wsUrl.replace(/^ws(s?):/, 'http$1:').replace(/\/ws\/?$/, '/sse')
  const derivedHttp = wsUrl.replace(/^ws(s?):/, 'http$1:').replace(/\/ws\/?$/, '/http')
  return { wsUrl, sseUrl: sseUrl ?? derivedSse, httpUrl: httpUrl ?? derivedHttp }
}

/** Cria o transporte concreto para um modo ('auto' é resolvido pelo LiveConnection). */
export function createClientTransport(
  mode: ClientTransportMode | ClientTransportFactory,
  endpoints: ClientTransportEndpoints,
): ClientTransport {
  if (typeof mode === 'function') return mode(endpoints)
  if (mode === 'sse') return new SseClientTransport(endpoints.sseUrl)
  if (mode === 'http') return new HttpPollingClientTransport(endpoints.httpUrl)
  return new WebSocketClientTransport(endpoints.wsUrl)
}
