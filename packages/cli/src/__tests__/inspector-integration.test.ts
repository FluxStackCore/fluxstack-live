// Inspector contra um LiveServer real, sem rede nem terminal:
// o transporte em memória captura o WebSocketConfig do servidor e cada
// InspectorSession fala com ele por um GenericWebSocket fake.
import { describe, it, expect, afterEach } from 'vitest'
import { LiveServer, LiveComponent } from '@fluxstack/live'
import type { GenericWebSocket, LiveTransport, LiveWSData, WebSocketConfig } from '@fluxstack/live'
import { InspectorSession, resolveConfig } from '../session'

// eslint-disable-next-line no-control-regex
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

class InspCounter extends LiveComponent<{ count: number; meta: Record<string, number> }> {
  static componentName = 'InspCounter'
  static defaultState = { count: 0, meta: {} as Record<string, number> }
  static publicActions = ['increment', 'mark', 'blast'] as const

  increment(payload: { by?: number } = {}) {
    this.state.count += payload.by ?? 1
    return this.state.count
  }

  mark(payload: { key: string }) {
    this.setState({ meta: { ...this.state.meta, [payload.key]: 1 } })
    return true
  }

  /** delta binário (frame 0x01) com encoder próprio */
  blast() {
    this.sendBinaryDelta({ count: 99 }, (d) => new Uint8Array([0xca, 0xfe, d.count ?? 0]))
    return true
  }
}

class CaptureTransport implements LiveTransport {
  config: WebSocketConfig | null = null
  registerWebSocket(config: WebSocketConfig) { this.config = config }
  registerHttpRoutes() {}
}

class FakeSocket implements GenericWebSocket {
  data = {} as LiveWSData
  readonly remoteAddress = '127.0.0.1'
  readyState: 0 | 1 | 2 | 3 = 1
  constructor(private readonly deliver: (frame: string | Uint8Array) => void) {}
  send(data: string | ArrayBuffer | Uint8Array) {
    if (this.readyState !== 1) return
    this.deliver(typeof data === 'string' ? data : data instanceof Uint8Array ? data : new Uint8Array(data))
  }
  close() { this.readyState = 3 }
}

interface Client {
  session: InspectorSession
  lines: string[]
  socket: FakeSocket
  out: () => string
  run: (cmd: string) => Promise<void>
}

let server: LiveServer | null = null
const sockets: FakeSocket[] = []

afterEach(async () => {
  for (const s of sockets.splice(0)) await transport?.config?.onClose(s, 1000, 'fim')
  await server?.shutdown()
  server = null
})

let transport: CaptureTransport | null = null

async function startServer() {
  transport = new CaptureTransport()
  server = new LiveServer({ transport, components: [InspCounter as never], httpPrefix: false })
  await server.start()
  return server
}

async function connect(): Promise<Client> {
  const cfg = transport!.config!
  const lines: string[] = []
  let session!: InspectorSession
  const socket = new FakeSocket((frame) => session.handleMessage(frame))
  sockets.push(socket)
  session = new InspectorSession(resolveConfig({}), {
    // o servidor processa de forma assíncrona; os testes esperam pelo efeito
    send: (text) => { void cfg.onMessage(socket, text, false) },
    log: (line) => lines.push(strip(line)),
  })
  await cfg.onOpen(socket)
  return {
    session,
    lines,
    socket,
    out: () => lines.join('\n'),
    run: async (cmd) => { await session.execCommand(cmd) },
  }
}

/** espera a resposta do mount (o STATE_UPDATE inicial chega antes dela) */
async function untilMounted(c: Client) {
  await until(() => c.out().includes('componente montado:'))
}

async function until(cond: () => boolean, ms = 3000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout esperando condição')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('inspector ⇄ LiveServer real', () => {
  it('recebe CONNECTION_ESTABLISHED ao conectar', async () => {
    await startServer()
    const c = await connect()
    await until(() => c.out().includes('CONNECTION_ESTABLISHED'))
    expect(c.out()).toMatch(/connectionId: \S+/)
  })

  it('mount → action → delta: o estado espelhado acompanha o servidor', async () => {
    await startServer()
    const c = await connect()

    await c.run('mount InspCounter {"count": 2}')
    await untilMounted(c)
    const cid = c.session.activeComponentId
    expect(c.session.mountedComponents.get(cid)).toMatchObject({ name: 'InspCounter', state: { count: 2 } })
    expect(c.out()).toContain(`componente montado: InspCounter (${cid})`)

    await c.run('action increment {"by": 5}')
    await until(() => c.session.mountedComponents.get(cid)!.state.count === 7)
    // expectResponse: o servidor devolve ACTION_RESPONSE com o resultado
    await until(() => c.out().includes('ACTION_RESPONSE'))
    expect(c.out()).toContain('result: 7')
    expect(c.out()).toContain('Δ count = 7')

    await c.run('action mark {"key": "a"}')
    await until(() => (c.session.mountedComponents.get(cid)!.state.meta as Record<string, number>)?.a === 1)

    c.lines.length = 0
    await c.run('state')
    expect(c.out()).toContain('"count": 7')
  })

  it('action inexistente volta como erro do servidor', async () => {
    await startServer()
    const c = await connect()
    await c.run('mount InspCounter')
    await untilMounted(c)
    await c.run('action naoExiste')
    await until(() => /ERROR|success: false/.test(c.out()))
  })

  it('delta binário 0x01 (sendBinaryDelta) é decodificado com cid e payload', async () => {
    await startServer()
    const c = await connect()
    await c.run('mount InspCounter')
    await untilMounted(c)
    const cid = c.session.activeComponentId

    await c.run('action blast')
    await until(() => c.out().includes('BIN_STATE_DELTA'))
    expect(c.out()).toContain(`cid: ${cid}`)
    expect(c.out()).toContain('payload: 3 bytes  ca fe 63')
  })

  it('room join/emit: evento chega a outro membro; formato antigo (event no topo) é recusado', async () => {
    await startServer()
    const a = await connect()
    const b = await connect()
    for (const c of [a, b]) {
      await c.run('mount InspCounter')
      await untilMounted(c)
      await c.run('room join sala-x')
    }
    await until(() => a.out().includes('ROOM_JOINED') && b.out().includes('ROOM_JOINED'))

    await a.run('room emit sala-x aviso {"texto": "oi"}')
    await until(() => b.out().includes('ROOM_EVENT'))
    expect(b.out()).toContain('event: aviso')
    expect(b.out()).toContain('"texto":"oi"')

    // o que o inspector mandava antes: event/data no topo → servidor recusa
    b.lines.length = 0
    await b.run(`send {"type":"ROOM_EMIT","componentId":"${b.session.activeComponentId}","roomId":"sala-x","event":"aviso","data":{}}`)
    await until(() => b.out().includes('payload.event must be a string'))
  })

  it('unmount libera o componente no servidor', async () => {
    const srv = await startServer()
    const c = await connect()
    await c.run('mount InspCounter')
    await untilMounted(c)
    expect(srv.registry.getStats().components).toBe(1)
    await c.run('unmount')
    await until(() => srv.registry.getStats().components === 0)
    expect(c.session.activeComponentId).toBe('')
  })
})
