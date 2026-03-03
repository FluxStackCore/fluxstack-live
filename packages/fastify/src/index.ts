// @fluxstack/live-fastify - Fastify Transport Adapter
//
// Bridges @fluxstack/live with Fastify + @fastify/websocket.
//
// Plugin (recommended):
//   import Fastify from 'fastify'
//   import { live } from '@fluxstack/live-fastify'
//
//   const app = Fastify()
//   await app.register(live, { componentsPath: './components' })
//   await app.listen({ port: 3000 })
//
// Factory (when you need liveServer ref):
//   import { fastifyLive } from '@fluxstack/live-fastify'
//   const app = Fastify()
//   const { liveServer } = await fastifyLive(app, { componentsPath: './components' })
//   await app.listen({ port: 3000 })
//
// Advanced (manual wiring):
//   import { FastifyTransport } from '@fluxstack/live-fastify'
//   const transport = new FastifyTransport(app)
//   const liveServer = new LiveServer({ transport, componentsPath: '...' })
//   await liveServer.start()

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { WebSocket as WsWebSocket } from 'ws'
import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import type {
  LiveTransport,
  WebSocketConfig,
  HttpRouteDefinition,
  GenericWebSocket,
  LiveWSData,
} from '@fluxstack/live'

export interface FastifyTransportOptions {
  /** Maximum payload size for WebSocket messages. Defaults to 10MB. */
  maxPayload?: number
  /** Enable per-message deflate compression. Defaults to false. */
  perMessageDeflate?: boolean
}

export class FastifyTransport implements LiveTransport {
  private app: FastifyInstance
  private wsConfig?: WebSocketConfig
  private options: FastifyTransportOptions

  constructor(app: FastifyInstance, options: FastifyTransportOptions = {}) {
    this.app = app
    this.options = options
  }

  registerWebSocket(config: WebSocketConfig): void {
    this.wsConfig = config

    this.app.get(
      config.path,
      { websocket: true },
      (socket: WsWebSocket, req: FastifyRequest) => {
        const ws = wrapFastifyWs(socket, req)

        config.onOpen(ws)

        socket.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary?: boolean) => {
          let message: unknown
          const binary = isBinary ?? false

          if (binary) {
            if (data instanceof Buffer) {
              message = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
            } else if (data instanceof ArrayBuffer) {
              message = data
            } else {
              message = Buffer.concat(data as Buffer[])
            }
          } else {
            message = typeof data === 'string' ? data : data.toString('utf-8')
          }

          config.onMessage(ws, message, binary)
        })

        socket.on('close', (code: number, reason: Buffer) => {
          config.onClose(ws, code, reason?.toString('utf-8') ?? '')
        })

        socket.on('error', (error: Error) => {
          if (config.onError) config.onError(ws, error)
        })
      },
    )
  }

  registerHttpRoutes(routes: HttpRouteDefinition[]): void {
    for (const route of routes) {
      const handler = async (req: FastifyRequest, reply: FastifyReply) => {
        try {
          const request = {
            params: (req.params || {}) as Record<string, string>,
            query: (req.query || {}) as Record<string, string | undefined>,
            body: req.body,
            headers: req.headers as Record<string, string | undefined>,
          }

          const response = await route.handler(request as any)
          reply.status(response.status ?? 200)
          if (response.headers) {
            for (const [key, value] of Object.entries(response.headers)) {
              reply.header(key, value)
            }
          }
          return reply.send(response.body)
        } catch (error: any) {
          return reply.status(500).send({ error: error.message })
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

  async shutdown(): Promise<void> {
    // Fastify handles WebSocket cleanup via @fastify/websocket on close
  }
}

/**
 * Wrap a raw `ws` WebSocket (from @fastify/websocket v11+) into GenericWebSocket.
 */
function wrapFastifyWs(rawWs: WsWebSocket, req?: FastifyRequest): GenericWebSocket {
  const dataStore: { value: LiveWSData } = {
    value: undefined as any,
  }

  const ws: GenericWebSocket = {
    send(data: string | ArrayBuffer | Uint8Array, compress?: boolean) {
      if (rawWs.readyState === WsWebSocket.OPEN) {
        rawWs.send(data, { compress: compress ?? false })
      }
    },
    close(code?: number, reason?: string) {
      rawWs.close(code, reason)
    },
    get data(): LiveWSData {
      return dataStore.value
    },
    set data(value: LiveWSData) {
      dataStore.value = value
    },
    get remoteAddress(): string {
      return req?.ip || req?.socket?.remoteAddress || ''
    },
    get readyState(): 0 | 1 | 2 | 3 {
      return (rawWs.readyState ?? 3) as 0 | 1 | 2 | 3
    },
  }

  return ws
}

// -- Plug-and-play helpers --

export interface FastifyLiveOptions extends FastifyTransportOptions {
  /** Components path for auto-discovery */
  componentsPath?: string
  /** WebSocket endpoint path. Defaults to '/api/live/ws' */
  wsPath?: string
  /** HTTP monitoring routes prefix. Defaults to '/api/live'. Set to false to disable. */
  httpPrefix?: string | false
  /** Enable debug mode. Defaults to false. */
  debug?: boolean
  /** URL path to serve the browser client bundle. Defaults to '/live-client.js'. Set to false to disable. */
  clientPath?: string | false
}

/**
 * Resolve the filesystem path to the @fluxstack/live-client IIFE browser bundle.
 */
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
 * Register a route that serves the @fluxstack/live-client browser bundle.
 */
function registerClientBundle(app: FastifyInstance, clientPath: string | false | undefined): void {
  if (clientPath === false) return
  const route = clientPath || '/live-client.js'

  const bundlePath = resolveClientBundlePath()
  if (!bundlePath) return

  const bundle = readFileSync(bundlePath, 'utf-8')

  app.get(route, (_req: FastifyRequest, reply: FastifyReply) => {
    reply
      .header('Content-Type', 'application/javascript')
      .header('Cache-Control', 'public, max-age=86400')
      .send(bundle)
  })
}

export interface FastifyLiveResult {
  /** The LiveServer instance (rooms, registry, etc.) */
  liveServer: import('@fluxstack/live').LiveServer
}

/**
 * Plug-and-play: wire up @fluxstack/live on a Fastify app in one call.
 *
 * @example
 * ```ts
 * import Fastify from 'fastify'
 * import { fastifyLive } from '@fluxstack/live-fastify'
 *
 * const app = Fastify()
 * const { liveServer } = await fastifyLive(app, {
 *   componentsPath: './components',
 * })
 * await app.listen({ port: 3000 })
 * ```
 */
export async function fastifyLive(
  app: FastifyInstance,
  options: FastifyLiveOptions = {},
): Promise<FastifyLiveResult> {
  const { LiveServer } = await import('@fluxstack/live')
  const fastifyWebsocket = await import('@fastify/websocket')

  // Register @fastify/websocket if not already registered
  if (!app.hasDecorator('websocketServer')) {
    await app.register(fastifyWebsocket.default, {
      options: {
        maxPayload: options.maxPayload ?? 10 * 1024 * 1024,
        perMessageDeflate: options.perMessageDeflate ?? false,
      },
    })
  }

  const { componentsPath, wsPath, httpPrefix, debug, clientPath, ...transportOpts } = options

  registerClientBundle(app, clientPath)

  const transport = new FastifyTransport(app, transportOpts)

  const liveServer = new LiveServer({
    transport,
    componentsPath,
    wsPath,
    httpPrefix,
    debug,
  })

  await liveServer.start()

  // Graceful shutdown
  app.addHook('onClose', async () => {
    await liveServer.shutdown()
  })

  return { liveServer }
}

// -- Fastify Plugin (.register) helper --

import fp from 'fastify-plugin'

/**
 * Fastify plugin that wires up @fluxstack/live automatically.
 *
 * @example
 * ```ts
 * import Fastify from 'fastify'
 * import { live } from '@fluxstack/live-fastify'
 *
 * const app = Fastify()
 * await app.register(live, { componentsPath: './components', debug: true })
 * await app.listen({ port: 3000 })
 * ```
 */
export const live = fp<FastifyLiveOptions>(
  async (app, options) => {
    const result = await fastifyLive(app, options)

    // Decorate the Fastify instance with the liveServer reference
    app.decorate('liveServer', result.liveServer)
  },
  {
    name: '@fluxstack/live-fastify',
    fastify: '>=4.0.0',
  },
)

// Augment Fastify types so app.liveServer is typed
declare module 'fastify' {
  interface FastifyInstance {
    liveServer: import('@fluxstack/live').LiveServer
  }
}

export { FastifyTransport as default }
