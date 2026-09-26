// Transporte SSE com Elysia REAL em porta de rede (Bun runtime).
//
// Run with: cd packages/elysia && bun test
//
// Prova o caminho completo por HTTP de verdade: stream text/event-stream,
// POST com corpo cru (parse: 'none'), frames binários e desconexão.

import { describe, it, expect, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import { LiveServer, LiveComponent } from '@fluxstack/live'
import { LiveConnection } from '@fluxstack/live-client'
import { ElysiaTransport } from '../index'

class SseEcho extends LiveComponent<{ count: number; text: string }> {
  static componentName = 'SseEcho'
  static defaultState = { count: 0, text: '' }
  static publicActions = ['increment', 'echo'] as const

  increment(payload: { by?: number } = {}) {
    this.state.count += payload.by ?? 1
    return this.state.count
  }
  echo(payload: { text: string }) {
    this.state.text = payload.text
    return payload.text
  }
}

const until = async (cond: () => boolean, ms = 5000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout esperando condição')
    await new Promise(r => setTimeout(r, 10))
  }
}

describe('ElysiaTransport — SSE sobre HTTP real', () => {
  let app: Elysia | null = null
  let server: LiveServer | null = null
  let conn: LiveConnection | null = null

  afterEach(async () => {
    conn?.destroy()
    conn = null
    await server?.shutdown()
    server = null
    app?.stop()
    app = null
  })

  async function start() {
    app = new Elysia()
    server = new LiveServer({
      transport: new ElysiaTransport(app),
      components: [SseEcho as never],
      httpPrefix: false,
      sse: { heartbeatMs: 0 },
    })
    await server.start()
    app.listen(0)
    const port = app.server!.port
    conn = new LiveConnection({
      url: `ws://127.0.0.1:${port}/api/live/ws`,
      transport: 'sse',
      heartbeatInterval: 60_000,
    })
    await until(() => !!conn!.state.connectionId)
    return { port, conn, server }
  }

  it('conecta via SSE, executa actions e recebe deltas', async () => {
    const { conn, server } = await start()
    expect(conn.state.transport).toBe('sse')
    expect(server.sseHub?.size).toBe(1)

    const mount = await conn.sendMessageAndWait({
      type: 'COMPONENT_MOUNT', componentId: '', payload: { component: 'SseEcho', props: {} },
    } as never)
    const componentId = (mount.result as { componentId: string }).componentId

    const deltas: unknown[] = []
    conn.registerComponent(componentId, (m) => { if (m.type === 'STATE_DELTA') deltas.push(m) })

    // texto com quebras de linha e unicode atravessa o stream intacto
    const text = 'linha 1\nlinha 2\r\nação ✓'
    const res = await conn.sendMessageAndWait({
      type: 'CALL_ACTION', componentId, action: 'echo', payload: { text },
    } as never)
    expect(res.result).toBe(text)

    for (let i = 0; i < 5; i++) {
      await conn.sendMessageAndWait({ type: 'CALL_ACTION', componentId, action: 'increment', payload: {} } as never)
    }
    await until(() => deltas.length >= 2)
  })

  it('desconectar libera a conexão no servidor', async () => {
    const { conn, server } = await start()
    conn.disconnect()
    await until(() => server.sseHub?.size === 0)
  })

  it('POST com sessão desconhecida responde 404', async () => {
    const { port } = await start()
    const res = await fetch(`http://127.0.0.1:${port}/api/live/sse/send`, {
      method: 'POST',
      headers: { 'x-live-session': 'forjado', 'content-type': 'application/json' },
      body: '{"type":"PING"}',
    })
    expect(res.status).toBe(404)
  })
})
