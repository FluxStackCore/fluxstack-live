// @fluxstack/live-elysia - Elysia Transport Adapter
//
// Bridges @fluxstack/live with Elysia's WebSocket and HTTP routing.
//
// Usage:
//   import Elysia from 'elysia'
//   import { LiveServer } from '@fluxstack/live'
//   import { ElysiaTransport } from '@fluxstack/live-elysia'
//
//   const app = new Elysia()
//   const liveServer = new LiveServer({ transport: new ElysiaTransport(app) })
//   await liveServer.start()
//   app.listen(3000)

import { readFileSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import type { AnyElysia } from 'elysia'
import type {
  LiveTransport,
  WebSocketConfig,
  HttpRouteDefinition,
  RawHttpRoute,
  GenericWebSocket,
  LiveWSData,
} from '@fluxstack/live'

/**
 * Formato mínimo do `ServerWebSocket` do Bun que o adapter usa. Tipado de forma
 * estrutural para não depender de `bun-types` nem dos genéricos do `ElysiaWS`.
 */
interface BunServerWsLike {
  send(data: string | ArrayBuffer | Uint8Array, compress?: boolean): number | void
  close(code?: number, reason?: string): void
  readonly readyState: number
  readonly remoteAddress?: string
  /** Slot de dados do Bun — o Elysia guarda aqui o contexto da rota (headers etc.). */
  readonly data?: unknown
}

/** O `ElysiaWS` expõe o socket cru em `.raw`; em versões antigas o próprio objeto é o socket. */
interface ElysiaWsLike {
  readonly raw?: BunServerWsLike
}

/** Propriedades "expando" gravadas pelo adapter no socket cru. */
type LiveRawWs = BunServerWsLike & {
  __liveWs?: GenericWebSocket
  __liveData?: LiveWSData
}

/** Headers no estilo Fetch (`Headers`) — só `get` é usado. */
interface HeadersLike {
  get?(name: string): string | null
}

/** Formato do contexto da rota que o Elysia grava em `raw.data`. */
interface ElysiaWsRouteData {
  headers?: HeadersLike
  server?: { upgrade?: { headers?: HeadersLike } }
}

/** Subconjunto do `Context` do Elysia usado nas rotas HTTP de monitoramento. */
interface ElysiaRouteContext {
  params?: Record<string, string>
  query?: Record<string, string | undefined>
  body: unknown
  headers?: Record<string, string | undefined>
  set: {
    status?: number | string
    headers: Record<string, string | number>
  }
}

function getRawWs(elysiaWs: ElysiaWsLike): LiveRawWs {
  return (elysiaWs.raw || elysiaWs) as LiveRawWs
}

export interface ElysiaTransportOptions {
  /**
   * Tamanho máximo de um frame WebSocket (bytes). O Bun corta antes de chegar
   * ao LiveServer. Default: 4MB (igual ao `maxMessageSize` do core).
   */
  maxPayloadLength?: number
}

export class ElysiaTransport implements LiveTransport {
  private app: AnyElysia
  private options: ElysiaTransportOptions

  constructor(app: AnyElysia, options: ElysiaTransportOptions = {}) {
    this.app = app
    this.options = options
  }

  /**
   * Rotas Fetch (Request/Response) — usadas pelo transporte SSE.
   * `parse: 'none'` impede o Elysia de consumir o corpo: o handler lê o
   * corpo cru (JSON ou binário) da Request original.
   */
  registerRawRoutes(routes: RawHttpRoute[]): void {
    for (const route of routes) {
      // Com `AnyElysia` o contexto chega como `{ [x: string]: any }`; recebemos
      // como `object` e estreitamos para o subconjunto que usamos.
      const handler = (context: object) => route.handler((context as { request: Request }).request)
      if (route.method === 'GET') this.app.get(route.path, handler)
      else this.app.post(route.path, handler, { parse: 'none' })
    }
  }

  registerWebSocket(config: WebSocketConfig): void {
    this.app.ws(config.path, {
      maxPayloadLength: this.options.maxPayloadLength ?? 4 * 1024 * 1024,
      open(elysiaWs: ElysiaWsLike) {
        // Wrap Elysia WS into GenericWebSocket
        const ws = wrapElysiaWs(elysiaWs)
        // Extract origin from upgrade request headers for CSRF validation.
        // Pre-set on ws.data so handleOpen() can read it before overwriting.
        try {
          const routeData = getRawWs(elysiaWs).data as ElysiaWsRouteData | undefined
          const origin = routeData?.headers?.get?.('origin')
            || routeData?.server?.upgrade?.headers?.get?.('origin')
            || undefined
          if (origin) {
            // Pré-preenchimento parcial: handleOpen() lê `origin` e depois
            // sobrescreve ws.data com o LiveWSData completo.
            const partial: Partial<LiveWSData> = { origin }
            ws.data = partial as LiveWSData
          }
        } catch { /* origin extraction is best-effort */ }
        config.onOpen(ws)
      },
      message(elysiaWs: ElysiaWsLike, rawMessage: unknown) {
        const ws = wrapElysiaWs(elysiaWs)
        const isBinary = rawMessage instanceof ArrayBuffer || rawMessage instanceof Uint8Array
        // Elysia auto-parses JSON messages into objects. LiveServer expects
        // raw strings, so re-stringify if needed.
        const message = (!isBinary && typeof rawMessage === 'object' && rawMessage !== null && !(rawMessage instanceof ArrayBuffer) && !(rawMessage instanceof Uint8Array))
          ? JSON.stringify(rawMessage)
          : rawMessage
        config.onMessage(ws, message, isBinary)
      },
      close(elysiaWs: ElysiaWsLike, code?: number, reason?: string) {
        const ws = wrapElysiaWs(elysiaWs)
        config.onClose(ws, code ?? 1000, reason ?? '')
      },
      // @ts-ignore - Elysia's error handler signature varies between versions
      error(elysiaWs: ElysiaWsLike, error: unknown) {
        if (config.onError) {
          const ws = wrapElysiaWs(elysiaWs)
          config.onError(ws, error instanceof Error ? error : new Error(String(error)))
        }
      },
    })
  }

  /**
   * Serve the @fluxstack/live-client IIFE browser bundle.
   * Defaults to `/live-client.js`. Pass `false` to disable.
   */
  registerClientBundle(clientPath?: string | false): void {
    if (clientPath === false) return
    const route = clientPath || '/live-client.js'

    const bundlePath = resolveClientBundlePath()
    if (!bundlePath) return

    const bundle = readFileSync(bundlePath, 'utf-8')

    this.app.get(route, () => {
      return new Response(bundle, {
        headers: {
          'Content-Type': 'application/javascript',
          'Cache-Control': 'public, max-age=86400',
        },
      })
    })
  }

  async shutdown(): Promise<void> {
    // Elysia/Bun manages WebSocket lifecycle internally
  }

  registerHttpRoutes(routes: HttpRouteDefinition[]): void {
    for (const route of routes) {
      const handler = async (context: object) => {
        const ctx = context as ElysiaRouteContext
        try {
          const request = {
            params: ctx.params || {},
            query: ctx.query || {},
            body: ctx.body,
            headers: ctx.headers || {},
          }

          const response = await route.handler(request)
          ctx.set.status = response.status ?? 200
          if (response.headers) {
            for (const [key, value] of Object.entries(response.headers)) {
              ctx.set.headers[key] = value
            }
          }
          return response.body
        } catch (error: unknown) {
          ctx.set.status = 500
          return { error: (error as { message?: string } | null | undefined)?.message }
        }
      }

      switch (route.method) {
        case 'GET':
          this.app.get(route.path, handler)
          break
        case 'POST':
          this.app.post(route.path, handler)
          break
        case 'PUT':
          this.app.put(route.path, handler)
          break
        case 'DELETE':
          this.app.delete(route.path, handler)
          break
      }
    }
  }
}

function resolveClientBundlePath(): string | null {
  try {
    const mainUrl = import.meta.resolve('@fluxstack/live-client')
    const mainPath = fileURLToPath(mainUrl)
    const distDir = dirname(mainPath)
    const bundlePath = join(distDir, 'live-client.browser.global.js')
    if (existsSync(bundlePath)) return bundlePath
  } catch {
    // @fluxstack/live-client not installed
  }
  return null
}

/**
 * Wrap Elysia's ServerWebSocket into a GenericWebSocket.
 *
 * Elysia stores its route context on `raw.data` (the Bun ServerWebSocket's data slot).
 * We must NOT overwrite it. Instead, LiveWSData is stored on a separate `__liveData`
 * property on the raw WS object.
 */
function wrapElysiaWs(elysiaWs: ElysiaWsLike): GenericWebSocket {
  // Elysia wraps the raw Bun ServerWebSocket. Access the raw ws:
  const raw = getRawWs(elysiaWs)

  // Reuse existing wrapper if already created (stored on the raw ws)
  if (raw.__liveWs) return raw.__liveWs

  const ws: GenericWebSocket = {
    send(data: string | ArrayBuffer | Uint8Array, compress?: boolean) {
      if (raw.readyState === 1) {
        return raw.send(data, compress)
      }
    },
    close(code?: number, reason?: string) {
      raw.close(code, reason)
    },
    get data(): LiveWSData {
      // Antes do handleOpen() ainda não existe — mesmo contrato de antes.
      return raw.__liveData as LiveWSData
    },
    set data(value: LiveWSData) {
      raw.__liveData = value
    },
    get remoteAddress(): string {
      return raw.remoteAddress || ''
    },
    get readyState(): 0 | 1 | 2 | 3 {
      return raw.readyState as 0 | 1 | 2 | 3
    }
  }

  raw.__liveWs = ws
  return ws
}

export { ElysiaTransport as default }
