// @fluxstack/live-express - Express Transport Adapter
//
// Bridges @fluxstack/live with Express HTTP + ws WebSocket library.
//
// Easiest (middleware):
//   import express from 'express'
//   import { live } from '@fluxstack/live-express'
//
//   const app = express()
//   app.use(live({ componentsPath: './components' }))
//   app.listen(3000)
//
// Factory (when you need httpServer/liveServer refs):
//   import { expressLive } from '@fluxstack/live-express'
//   const app = express()
//   const { httpServer, liveServer } = await expressLive(app, { componentsPath: './components' })
//   httpServer.listen(3000)
//
// Advanced (manual wiring):
//   import { ExpressTransport } from '@fluxstack/live-express'
//   const transport = new ExpressTransport(app, httpServer)
//   const liveServer = new LiveServer({ transport, componentsPath: '...' })
//   await liveServer.start()

import type { Express, Request, Response } from 'express'
import type { Server as HttpServer } from 'http'
import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { WebSocketServer, WebSocket as WsWebSocket } from 'ws'
import type {
  LiveTransport,
  WebSocketConfig,
  HttpRouteDefinition,
  GenericWebSocket,
  LiveWSData,
} from '@fluxstack/live'

export interface ExpressTransportOptions {
  /** Maximum payload size for WebSocket messages. Defaults to 10MB. */
  maxPayload?: number
  /** Enable per-message deflate compression. Defaults to false. */
  perMessageDeflate?: boolean
}

export class ExpressTransport implements LiveTransport {
  private app: Express
  private httpServer: HttpServer
  private wss?: WebSocketServer
  private wsConfig?: WebSocketConfig
  private options: ExpressTransportOptions

  constructor(app: Express, httpServer: HttpServer, options: ExpressTransportOptions = {}) {
    this.app = app
    this.httpServer = httpServer
    this.options = options
  }

  registerWebSocket(config: WebSocketConfig): void {
    this.wsConfig = config

    this.wss = new WebSocketServer({
      server: this.httpServer,
      path: config.path,
      maxPayload: this.options.maxPayload ?? 10 * 1024 * 1024,
      perMessageDeflate: this.options.perMessageDeflate ?? false,
    })

    this.wss.on('connection', (rawWs: WsWebSocket, req) => {
      const ws = wrapNodeWs(rawWs, req)

      config.onOpen(ws)

      rawWs.on('message', (data, isBinary) => {
        let message: unknown
        if (isBinary) {
          // Binary data as ArrayBuffer
          if (data instanceof Buffer) {
            message = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
          } else if (data instanceof ArrayBuffer) {
            message = data
          } else {
            // Array of Buffers
            message = Buffer.concat(data as Buffer[])
          }
        } else {
          // Text message
          message = data.toString('utf-8')
        }
        config.onMessage(ws, message, !!isBinary)
      })

      rawWs.on('close', (code, reason) => {
        config.onClose(ws, code, reason.toString('utf-8'))
      })

      rawWs.on('error', (error) => {
        if (config.onError) config.onError(ws, error)
      })
    })
  }

  registerHttpRoutes(routes: HttpRouteDefinition[]): void {
    for (const route of routes) {
      const handler = async (req: Request, res: Response) => {
        try {
          const request = {
            params: (req.params || {}) as Record<string, string>,
            query: (req.query || {}) as Record<string, string | undefined>,
            body: req.body,
            headers: req.headers as Record<string, string | undefined>,
          }

          const response = await route.handler(request as any)
          res.status(response.status ?? 200)
          if (response.headers) {
            for (const [key, value] of Object.entries(response.headers)) {
              res.setHeader(key, value)
            }
          }
          res.json(response.body)
        } catch (error: any) {
          res.status(500).json({ error: error.message })
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
    if (this.wss) {
      for (const client of this.wss.clients) {
        client.close(1001, 'Server shutting down')
      }
      this.wss.close()
    }
  }
}

/**
 * Wrap a `ws` WebSocket into GenericWebSocket.
 */
function wrapNodeWs(rawWs: WsWebSocket, req?: any): GenericWebSocket {
  // Store LiveWSData directly on the raw ws
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
      return req?.socket?.remoteAddress || ''
    },
    get readyState(): 0 | 1 | 2 | 3 {
      return rawWs.readyState as 0 | 1 | 2 | 3
    },
  }

  return ws
}

// ── Plug-and-play helper ──

export interface ExpressLiveOptions extends ExpressTransportOptions {
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
 * Uses import.meta.resolve() to find the package main entry, then looks for the
 * IIFE bundle in the same dist directory.
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
 * Reads the IIFE bundle once and caches it in memory.
 */
function registerClientBundle(app: Express, clientPath: string | false | undefined): void {
  if (clientPath === false) return
  const route = clientPath || '/live-client.js'

  const bundlePath = resolveClientBundlePath()
  if (!bundlePath) return

  const bundle = readFileSync(bundlePath, 'utf-8')

  app.get(route, (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/javascript')
    res.setHeader('Cache-Control', 'public, max-age=86400')
    res.send(bundle)
  })
}

export interface ExpressLiveResult {
  /** The HTTP server wrapping the Express app (needed for .listen()) */
  httpServer: HttpServer
  /** The LiveServer instance (rooms, registry, etc.) */
  liveServer: import('@fluxstack/live').LiveServer
}

/**
 * Plug-and-play: wire up @fluxstack/live on an Express app in one call.
 *
 * @example
 * ```ts
 * import express from 'express'
 * import { expressLive } from '@fluxstack/live-express'
 *
 * const app = express()
 * const { httpServer, liveServer } = await expressLive(app, {
 *   componentsPath: './components',
 * })
 * httpServer.listen(3000)
 * ```
 */
export async function expressLive(
  app: Express,
  options: ExpressLiveOptions = {},
): Promise<ExpressLiveResult> {
  const { LiveServer } = await import('@fluxstack/live')
  const { createServer } = await import('http')

  const { componentsPath, wsPath, httpPrefix, debug, clientPath, ...transportOpts } = options

  registerClientBundle(app, clientPath)

  const httpServer = createServer(app)
  const transport = new ExpressTransport(app, httpServer, transportOpts)

  const liveServer = new LiveServer({
    transport,
    componentsPath,
    wsPath,
    httpPrefix,
    debug,
  })

  await liveServer.start()

  return { httpServer, liveServer }
}

// ── Middleware (.use) helper ──

import type { NextFunction } from 'express'

export interface LiveMiddlewareResult {
  /** The middleware function to pass to app.use() */
  (req: Request, res: Response, next: NextFunction): void
  /** The LiveServer instance (available after app.listen() resolves) */
  liveServer: import('@fluxstack/live').LiveServer | null
}

/**
 * Express middleware that wires up @fluxstack/live automatically.
 * Hooks into `app.listen()` to capture the httpServer and attach WebSocket.
 *
 * @example
 * ```ts
 * import express from 'express'
 * import { live } from '@fluxstack/live-express'
 *
 * const app = express()
 * app.use(live(app, { componentsPath: './components' }))
 * app.listen(3000)
 * ```
 */
export function live(app: Express, options: ExpressLiveOptions = {}): LiveMiddlewareResult {
  let liveServer: import('@fluxstack/live').LiveServer | null = null

  // Serve the client bundle automatically
  registerClientBundle(app, options.clientPath)

  // Hook app.listen() immediately to capture the httpServer
  const originalListen = app.listen.bind(app)

  ;(app as any).listen = function patchedListen(...args: any[]) {
    const httpServer: HttpServer = originalListen(...args)

    // Attach live system to the server (async, WS can attach to a running server)
    const { componentsPath, wsPath, httpPrefix, debug, clientPath: _, ...transportOpts } = options
    const transport = new ExpressTransport(app, httpServer, transportOpts)

    import('@fluxstack/live').then(({ LiveServer }) => {
      liveServer = new LiveServer({
        transport,
        componentsPath,
        wsPath,
        httpPrefix,
        debug,
      })
      middleware.liveServer = liveServer
      liveServer.start().then(() => {
        if (debug) {
          console.log(`[live] Components: ${liveServer!.registry.getRegisteredComponentNames().join(', ')}`)
        }
      })
    })

    // Handle graceful shutdown
    const onShutdown = async () => {
      if (liveServer) await liveServer.shutdown()
      httpServer.close()
      process.exit(0)
    }
    process.on('SIGINT', onShutdown)
    process.on('SIGTERM', onShutdown)

    return httpServer
  }

  const middleware: LiveMiddlewareResult = Object.assign(
    function liveMiddleware(_req: Request, _res: Response, next: NextFunction) {
      next()
    },
    { liveServer: null as import('@fluxstack/live').LiveServer | null },
  )

  return middleware
}

export { ExpressTransport as default }
