// @fluxstack/live - Transporte SSE (Server-Sent Events + POST HTTP)
//
// Servidor→cliente: stream `text/event-stream` (GET `path`).
// Cliente→servidor: cada frame num POST `path/send`, autenticado pelo token de
// sessão entregue no primeiro evento do stream.
//
// O hub apresenta cada conexão SSE ao LiveServer como um `GenericWebSocket`
// virtual: auth, rate limit, posse de componente, salas, uploads — tudo no core
// continua valendo sem nenhum caminho especial.
//
// Só usa APIs padrão da web (Request, Response, ReadableStream, crypto), então
// roda em Bun, Deno, Node 18+ e edge. Adapters apenas montam as rotas.
//
// Formato dos eventos:
//   event: session  data: {"token":"..."}          (sempre o primeiro)
//   event: message  data: <frame JSON>
//   event: binary   data: <frame binário em base64>
//   event: close    data: {"code":1000,"reason":"..."}
//   : ping                                         (heartbeat / comentário)

import type { GenericWebSocket, LiveWSData, RawHttpRoute, WebSocketConfig } from './types'
import { LIVE_SESSION_HEADER, handleSessionSend, randomToken, toBase64 } from './http-common'

/** Header com o token de sessão em cada POST. */
export const SSE_SESSION_HEADER = LIVE_SESSION_HEADER

export interface SseTransportOptions {
  /** Caminho do stream. POST vai para `${path}/send`. Default: '/api/live/sse' */
  path?: string
  /** Intervalo do heartbeat (comentário `: ping`). Default: 15000ms */
  heartbeatMs?: number
  /**
   * Bytes pendentes tolerados no stream de um cliente lento. Acima disso a
   * conexão é fechada (o cliente reconecta e re-hidrata). Default: 4MB.
   */
  maxBufferedBytes?: number
  /** Tamanho máximo do corpo de um POST. Default: 4MB. */
  maxMessageSize?: number
  /** Extrai o IP do cliente (Request padrão não expõe). */
  getRemoteAddress?: (request: Request) => string
}

export const DEFAULT_SSE_PATH = '/api/live/sse'

const encoder = new TextEncoder()

/** Formata um evento SSE. Quebras de linha no dado viram múltiplas linhas `data:`. */
export function formatSseEvent(event: string, data: string): string {
  return `event: ${event}\ndata: ${data.replace(/\r\n|\r|\n/g, '\ndata: ')}\n\n`
}

/** Conexão SSE vista pelo LiveServer como um WebSocket. */
class SseSocket implements GenericWebSocket {
  data: LiveWSData
  private state: 1 | 3 = 1
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null
  /** frames enviados antes do stream começar (ex.: CONNECTION_ESTABLISHED no onOpen) */
  private pending: Uint8Array[] = []

  constructor(
    readonly token: string,
    readonly remoteAddress: string,
    origin: string | undefined,
    private readonly maxBufferedBytes: number,
    private readonly onClosed: (socket: SseSocket, code: number, reason: string) => void,
  ) {
    // O adapter pré-preenche `origin` — o LiveServer lê antes de substituir `data`.
    this.data = { origin } as LiveWSData
  }

  get readyState(): 0 | 1 | 2 | 3 { return this.state }

  /** Liga o socket ao stream e despeja o que ficou pendente. */
  attach(controller: ReadableStreamDefaultController<Uint8Array>): void {
    this.controller = controller
    controller.enqueue(encoder.encode(formatSseEvent('session', JSON.stringify({ token: this.token }))))
    for (const chunk of this.pending) controller.enqueue(chunk)
    this.pending = []
  }

  private write(chunk: Uint8Array): void {
    if (this.state !== 1) return
    if (!this.controller) {
      this.pending.push(chunk)
      return
    }
    try {
      this.controller.enqueue(chunk)
    } catch {
      this.markClosed(1006, 'stream error')
      return
    }
    // desiredSize negativo = cliente não está consumindo. Passou do limite → fecha.
    const desired = this.controller.desiredSize
    if (desired !== null && desired < 0) {
      this.close(1008, 'SSE backpressure: client too slow')
    }
  }

  send(data: string | ArrayBuffer | Uint8Array): void {
    const frame = typeof data === 'string'
      ? formatSseEvent('message', data)
      : formatSseEvent('binary', toBase64(data))
    this.write(encoder.encode(frame))
  }

  ping(): void {
    this.write(encoder.encode(': ping\n\n'))
  }

  close(code = 1000, reason = ''): void {
    if (this.state !== 1) return
    const frame = encoder.encode(formatSseEvent('close', JSON.stringify({ code, reason })))
    try {
      if (this.controller) {
        this.controller.enqueue(frame)
        this.controller.close()
      }
    } catch { /* stream já encerrado pelo cliente */ }
    this.markClosed(code, reason)
  }

  /** Estado final + notifica o hub uma única vez. */
  markClosed(code: number, reason: string): void {
    if (this.state === 3) return
    this.state = 3
    this.controller = null
    this.pending = []
    this.onClosed(this, code, reason)
  }

  get bufferLimit(): number { return this.maxBufferedBytes }
}

/**
 * Hub de conexões SSE. Recebe os mesmos callbacks que um adapter WebSocket
 * recebe (`WebSocketConfig`) e expõe duas rotas HTTP padrão.
 */
export class SseConnectionHub {
  readonly path: string
  private readonly sockets = new Map<string, SseSocket>()
  private readonly heartbeatMs: number
  private readonly maxBufferedBytes: number
  private readonly maxMessageSize: number
  private readonly getRemoteAddress: (request: Request) => string
  private heartbeat: ReturnType<typeof setInterval> | null = null

  constructor(private readonly config: Omit<WebSocketConfig, 'path'>, options: SseTransportOptions = {}) {
    this.path = options.path ?? DEFAULT_SSE_PATH
    this.heartbeatMs = options.heartbeatMs ?? 15000
    this.maxBufferedBytes = options.maxBufferedBytes ?? 4 * 1024 * 1024
    this.maxMessageSize = options.maxMessageSize ?? 4 * 1024 * 1024
    this.getRemoteAddress = options.getRemoteAddress ?? ((req) => req.headers.get('x-real-ip') ?? '')
  }

  /** Rotas a registrar no framework HTTP. */
  routes(): RawHttpRoute[] {
    return [
      { method: 'GET', path: this.path, handler: (req) => this.handleStream(req) },
      { method: 'POST', path: `${this.path}/send`, handler: (req) => this.handleSend(req) },
    ]
  }

  /** Conexões SSE abertas. */
  get size(): number { return this.sockets.size }

  /** GET: abre o stream de eventos. */
  handleStream(request: Request): Response {
    const token = randomToken()
    const origin = request.headers.get('origin') ?? undefined
    const socket = new SseSocket(token, this.getRemoteAddress(request), origin, this.maxBufferedBytes, (s, code, reason) => {
      this.sockets.delete(s.token)
      if (this.sockets.size === 0) this.stopHeartbeat()
      void this.config.onClose(s, code, reason)
    })

    this.sockets.set(token, socket)
    // O LiveServer valida origem, cria connectionId e envia CONNECTION_ESTABLISHED
    // (que fica pendente até o stream começar, depois do evento `session`).
    void this.config.onOpen(socket)
    if (socket.readyState !== 1) {
      // rejeitado no onOpen (ex.: origem fora da allowlist)
      return new Response('Forbidden', { status: 403 })
    }

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => socket.attach(controller),
      cancel: () => socket.markClosed(1001, 'client disconnected'),
    }, new ByteLengthQueuingStrategy({ highWaterMark: socket.bufferLimit }))

    this.startHeartbeat()

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, no-transform',
        Connection: 'keep-alive',
        // nginx: não bufferizar o stream
        'X-Accel-Buffering': 'no',
      },
    })
  }

  /** POST: recebe um frame do cliente. */
  async handleSend(request: Request): Promise<Response> {
    return handleSessionSend(request, this.sockets, this.config, this.maxMessageSize)
  }

  /** Fecha todas as conexões (shutdown). */
  closeAll(code = 1001, reason = 'server shutdown'): void {
    for (const socket of Array.from(this.sockets.values())) socket.close(code, reason)
    this.stopHeartbeat()
  }

  private startHeartbeat(): void {
    if (this.heartbeat || this.heartbeatMs <= 0) return
    this.heartbeat = setInterval(() => {
      for (const socket of this.sockets.values()) socket.ping()
    }, this.heartbeatMs)
    // não segura o processo vivo só pelo heartbeat
    ;(this.heartbeat as { unref?: () => void }).unref?.()
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
  }
}
