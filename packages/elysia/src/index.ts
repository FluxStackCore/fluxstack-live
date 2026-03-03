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
import type { Elysia } from 'elysia'
import type {
  LiveTransport,
  WebSocketConfig,
  HttpRouteDefinition,
  GenericWebSocket,
  LiveWSData,
} from '@fluxstack/live'

export class ElysiaTransport implements LiveTransport {
  private app: Elysia<any>

  constructor(app: Elysia<any>) {
    this.app = app
  }

  registerWebSocket(config: WebSocketConfig): void {
    this.app.ws(config.path, {
      open(elysiaWs: any) {
        // Wrap Elysia WS into GenericWebSocket
        const ws = wrapElysiaWs(elysiaWs)
        config.onOpen(ws)
      },
      message(elysiaWs: any, rawMessage: unknown) {
        const ws = wrapElysiaWs(elysiaWs)
        const isBinary = rawMessage instanceof ArrayBuffer || rawMessage instanceof Uint8Array
        // Elysia auto-parses JSON messages into objects. LiveServer expects
        // raw strings, so re-stringify if needed.
        const message = (!isBinary && typeof rawMessage === 'object' && rawMessage !== null && !(rawMessage instanceof ArrayBuffer) && !(rawMessage instanceof Uint8Array))
          ? JSON.stringify(rawMessage)
          : rawMessage
        config.onMessage(ws, message, isBinary)
      },
      close(elysiaWs: any, code?: number, reason?: string) {
        const ws = wrapElysiaWs(elysiaWs)
        config.onClose(ws, code ?? 1000, reason ?? '')
      },
      // @ts-ignore - Elysia's error handler signature varies between versions
      error(elysiaWs: any, error: any) {
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

  registerHttpRoutes(routes: HttpRouteDefinition[]): void {
    for (const route of routes) {
      const handler = async (ctx: any) => {
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
function wrapElysiaWs(elysiaWs: any): GenericWebSocket {
  // Elysia wraps the raw Bun ServerWebSocket. Access the raw ws:
  const raw = elysiaWs.raw || elysiaWs

  // Reuse existing wrapper if already created (stored on the raw ws)
  if (raw.__liveWs) return raw.__liveWs

  const ws: GenericWebSocket = {
    send(data: string | ArrayBuffer | Uint8Array, compress?: boolean) {
      return raw.send(data, compress)
    },
    close(code?: number, reason?: string) {
      raw.close(code, reason)
    },
    get data(): LiveWSData {
      return raw.__liveData as LiveWSData
    },
    set data(value: LiveWSData) {
      raw.__liveData = value
    },
    get remoteAddress(): string {
      return raw.remoteAddress || ''
    },
    get readyState(): 0 | 1 | 2 | 3 {
      return raw.readyState
    }
  }

  raw.__liveWs = ws
  return ws
}

export { ElysiaTransport as default }
