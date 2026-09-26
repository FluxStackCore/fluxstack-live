// @fluxstack/live - Transporte HTTP puro (long-polling + POST)
//
// O último recurso: funciona onde WebSocket e streaming não passam (proxies que
// bufferizam SSE, serverless com resposta curta, redes corporativas restritas).
// Só requisições HTTP comuns, curtas e independentes.
//
//   GET  {path}        abre a sessão → { token }
//   GET  {path}/poll   long-poll: devolve os frames pendentes na hora, ou espera
//                      até chegar algum (ou `pollTimeoutMs`) → { frames, closed? }
//   POST {path}/send   envia 1 frame (JSON ou binário), como no SSE
//   POST {path}/close  encerra a sessão (o cliente avisa ao desconectar; sem isso
//                      o servidor só perceberia no timeout de sessão)
//
// Como o SSE, cada sessão vira um `GenericWebSocket` virtual para o LiveServer:
// auth, rate limit, posse de componente, salas e uploads valem sem código especial.
//
// Frame no corpo do poll: { t: "<json>" } (texto) ou { b: "<base64>" } (binário).

import type { LiveWSData, RawHttpRoute, WebSocketConfig } from './types'
import { LIVE_SESSION_HEADER, handleSessionSend, randomToken, toBase64, type HttpSessionSocket } from './http-common'

export const DEFAULT_HTTP_POLLING_PATH = '/api/live/http'

export interface HttpPollingTransportOptions {
  /** Caminho base. Default: '/api/live/http' */
  path?: string
  /** Quanto um poll espera por frames antes de responder vazio. Default: 25000ms */
  pollTimeoutMs?: number
  /**
   * Sessão sem poll nem envio por esse tempo é encerrada (o cliente sumiu).
   * Deve ser maior que `pollTimeoutMs`. Default: 45000ms
   */
  sessionTimeoutMs?: number
  /** Bytes pendentes tolerados na fila de uma sessão. Acima → fecha (1008). Default: 4MB */
  maxBufferedBytes?: number
  /** Tamanho máximo do corpo de um POST. Default: 4MB */
  maxMessageSize?: number
  /** Extrai o IP do cliente (Request padrão não expõe). */
  getRemoteAddress?: (request: Request) => string
}

/** Frame entregue no corpo do poll. */
export type HttpPollFrame = { t: string } | { b: string }

/** Corpo da resposta de `GET {path}/poll`. */
export interface HttpPollResponse {
  frames: HttpPollFrame[]
  /** presente quando o servidor encerrou a sessão */
  closed?: { code: number; reason: string }
}

const NO_STORE = { 'Cache-Control': 'no-cache, no-store', 'Content-Type': 'application/json' }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: NO_STORE })
}

/** Sessão HTTP vista pelo LiveServer como um WebSocket. */
class PollingSocket implements HttpSessionSocket {
  data: LiveWSData
  private state: 1 | 3 = 1
  private queue: HttpPollFrame[] = []
  private queuedBytes = 0
  /** poll aguardando frames (no máximo um por sessão) */
  private waiter: { resolve: (r: HttpPollResponse) => void; timer: ReturnType<typeof setTimeout> } | null = null
  lastSeen = Date.now()

  constructor(
    readonly token: string,
    readonly remoteAddress: string,
    origin: string | undefined,
    private readonly maxBufferedBytes: number,
    private readonly onClosed: (socket: PollingSocket, code: number, reason: string) => void,
  ) {
    this.data = { origin } as LiveWSData
  }

  get readyState(): 0 | 1 | 2 | 3 { return this.state }
  get isWaiting(): boolean { return this.waiter !== null }

  send(data: string | ArrayBuffer | Uint8Array): void {
    if (this.state !== 1) return
    const frame: HttpPollFrame = typeof data === 'string' ? { t: data } : { b: toBase64(data) }
    const size = 't' in frame ? frame.t.length : frame.b.length
    this.queue.push(frame)
    this.queuedBytes += size
    if (this.queuedBytes > this.maxBufferedBytes) {
      // cliente não está buscando: descarta a fila e encerra (ele reconecta e re-hidrata)
      this.queue = []
      this.queuedBytes = 0
      this.close(1008, 'HTTP polling backpressure: client too slow')
      return
    }
    this.flush()
  }

  /** Atende um poll: responde já se há frames, senão espera até `timeoutMs`. */
  poll(timeoutMs: number): Promise<HttpPollResponse> {
    this.lastSeen = Date.now()
    // um poll novo substitui o anterior (ex.: aba recarregou a requisição)
    if (this.waiter) this.resolveWaiter()
    if (this.queue.length > 0) return Promise.resolve(this.drain())
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.resolveWaiter(), timeoutMs)
      this.waiter = { resolve, timer }
    })
  }

  private drain(closed?: { code: number; reason: string }): HttpPollResponse {
    const frames = this.queue
    this.queue = []
    this.queuedBytes = 0
    return closed ? { frames, closed } : { frames }
  }

  private resolveWaiter(closed?: { code: number; reason: string }): void {
    const w = this.waiter
    if (!w) return
    this.waiter = null
    clearTimeout(w.timer)
    this.lastSeen = Date.now()
    w.resolve(this.drain(closed))
  }

  private flush(): void {
    if (this.waiter) this.resolveWaiter()
  }

  close(code = 1000, reason = ''): void {
    if (this.state !== 1) return
    // o poll pendente (se houver) leva os últimos frames + o aviso de fechamento
    this.resolveWaiter({ code, reason })
    this.markClosed(code, reason)
  }

  markClosed(code: number, reason: string): void {
    if (this.state === 3) return
    this.state = 3
    if (this.waiter) this.resolveWaiter({ code, reason })
    this.queue = []
    this.queuedBytes = 0
    this.onClosed(this, code, reason)
  }
}

/**
 * Hub de sessões HTTP long-polling. Recebe os mesmos callbacks de um adapter
 * WebSocket (`WebSocketConfig`) e expõe três rotas HTTP padrão (Fetch API).
 */
export class HttpPollingHub {
  readonly path: string
  private readonly sockets = new Map<string, PollingSocket>()
  private readonly pollTimeoutMs: number
  private readonly sessionTimeoutMs: number
  private readonly maxBufferedBytes: number
  private readonly maxMessageSize: number
  private readonly getRemoteAddress: (request: Request) => string
  private sweeper: ReturnType<typeof setInterval> | null = null

  constructor(private readonly config: Omit<WebSocketConfig, 'path'>, options: HttpPollingTransportOptions = {}) {
    this.path = options.path ?? DEFAULT_HTTP_POLLING_PATH
    this.pollTimeoutMs = options.pollTimeoutMs ?? 25000
    this.sessionTimeoutMs = Math.max(options.sessionTimeoutMs ?? 45000, this.pollTimeoutMs + 1000)
    this.maxBufferedBytes = options.maxBufferedBytes ?? 4 * 1024 * 1024
    this.maxMessageSize = options.maxMessageSize ?? 4 * 1024 * 1024
    this.getRemoteAddress = options.getRemoteAddress ?? ((req) => req.headers.get('x-real-ip') ?? '')
  }

  routes(): RawHttpRoute[] {
    return [
      { method: 'GET', path: this.path, handler: (req) => this.handleConnect(req) },
      { method: 'GET', path: `${this.path}/poll`, handler: (req) => this.handlePoll(req) },
      { method: 'POST', path: `${this.path}/send`, handler: (req) => this.handleSend(req) },
      { method: 'POST', path: `${this.path}/close`, handler: (req) => this.handleClose(req) },
    ]
  }

  /** Sessões abertas. */
  get size(): number { return this.sockets.size }

  /** GET: abre a sessão. O CONNECTION_ESTABLISHED fica na fila para o 1º poll. */
  handleConnect(request: Request): Response {
    const token = randomToken()
    const origin = request.headers.get('origin') ?? undefined
    const socket = new PollingSocket(token, this.getRemoteAddress(request), origin, this.maxBufferedBytes, (s, code, reason) => {
      this.sockets.delete(s.token)
      if (this.sockets.size === 0) this.stopSweeper()
      void this.config.onClose(s, code, reason)
    })
    this.sockets.set(token, socket)
    void this.config.onOpen(socket)
    if (socket.readyState !== 1) return new Response('Forbidden', { status: 403 })
    this.startSweeper()
    return json({ token })
  }

  /** GET: long-poll. */
  async handlePoll(request: Request): Promise<Response> {
    const token = request.headers.get(LIVE_SESSION_HEADER)
    const socket = token ? this.sockets.get(token) : undefined
    if (!socket || socket.readyState !== 1) return new Response('Unknown session', { status: 404 })
    const origin = request.headers.get('origin')
    if (origin && socket.data?.origin && origin !== socket.data.origin) {
      return new Response('Origin mismatch', { status: 403 })
    }
    const result = await socket.poll(this.pollTimeoutMs)
    return json(result)
  }

  /** POST: recebe um frame do cliente. */
  handleSend(request: Request): Promise<Response> {
    return handleSessionSend(request, this.sockets, this.config, this.maxMessageSize, (s) => {
      if (s instanceof PollingSocket) s.lastSeen = Date.now()
    })
  }

  /** POST: o cliente encerrou a sessão. Idempotente (sessão já fechada → 204). */
  handleClose(request: Request): Response {
    const token = request.headers.get(LIVE_SESSION_HEADER)
    const socket = token ? this.sockets.get(token) : undefined
    if (socket) {
      const origin = request.headers.get('origin')
      if (origin && socket.data?.origin && origin !== socket.data.origin) {
        return new Response('Origin mismatch', { status: 403 })
      }
      socket.markClosed(1000, 'client disconnected')
    }
    return new Response(null, { status: 204 })
  }

  closeAll(code = 1001, reason = 'server shutdown'): void {
    for (const socket of Array.from(this.sockets.values())) socket.close(code, reason)
    this.stopSweeper()
  }

  /** Encerra sessões abandonadas (sem poll nem envio há `sessionTimeoutMs`). */
  sweep(now = Date.now()): void {
    for (const socket of Array.from(this.sockets.values())) {
      if (!socket.isWaiting && now - socket.lastSeen > this.sessionTimeoutMs) {
        socket.markClosed(1001, 'HTTP polling session timeout')
      }
    }
  }

  private startSweeper(): void {
    if (this.sweeper) return
    this.sweeper = setInterval(() => this.sweep(), Math.min(10000, this.sessionTimeoutMs))
    ;(this.sweeper as { unref?: () => void }).unref?.()
  }

  private stopSweeper(): void {
    if (this.sweeper) clearInterval(this.sweeper)
    this.sweeper = null
  }
}
