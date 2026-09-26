// Renovação do signedState (re-hidratação "de onde parou"), ponta a ponta:
//   LiveServer real (sse)  ⇄  LiveConnection real (transport sse), `fetch` em memória
//   (mesmo esquema de client-protocol.test.ts / sse-transport.test.ts).
//
// Antes: o signedState só era emitido no mount. O cliente re-hidratava com o
// snapshot do MOUNT e o componente voltava ao estado inicial, perdendo tudo que
// mudou depois. Agora o servidor renova a assinatura de forma THROTTLED
// (`stateSignature.renewInterval`) e manda `STATE_SIGNATURE { signedState }`.
// Ver .ai-notes/bugs/2026-09-26-divergencias-protocolo-cliente-servidor.md.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { LiveServer } from '../../packages/core/src/server/LiveServer'
import { LiveComponent } from '../../packages/core/src/component/LiveComponent'
import type { SignedState, StateSignatureConfig } from '../../packages/core/src/security/StateSignature'
import type { WebSocketResponse } from '../../packages/core/src/protocol/messages'
import type { LiveTransport, RawHttpRoute, WebSocketConfig } from '../../packages/core/src/transport/types'
import { LiveConnection } from '../../packages/client/src/connection'
import { SseClientTransport } from '../../packages/client/src/transports'
import { LiveComponentHandle } from '../../packages/client/src/component'
import {
  clientMessages,
  readMountResult,
  readRehydrateResult,
  readStateRehydrated,
  readStateSignature,
} from '../../packages/client/src/protocol'

// ===== Componentes de teste =====

class Tally extends LiveComponent<{ count: number }> {
  static componentName = 'Tally'
  static defaultState = { count: 0 }
  static publicActions = ['increment'] as const
  increment() {
    this.state.count += 1
    return this.state.count
  }
}

class Other extends LiveComponent<{ count: number }> {
  static componentName = 'Other'
  static defaultState = { count: 0 }
  static publicActions = [] as const
}

class SharedTally extends LiveComponent<{ count: number }> {
  static componentName = 'SharedTally'
  static singleton = true
  static defaultState = { count: 0 }
  static publicActions = ['increment'] as const
  increment() {
    this.state.count += 1
    return this.state.count
  }
}

// ===== Infra em memória =====

class MemoryTransport implements LiveTransport {
  routes = new Map<string, RawHttpRoute>()
  registerWebSocket(_config: WebSocketConfig) {}
  registerHttpRoutes() {}
  registerRawRoutes(routes: RawHttpRoute[]) {
    for (const r of routes) this.routes.set(`${r.method} ${r.path}`, r)
  }
  fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init)
    const route = this.routes.get(`${req.method} ${new URL(req.url).pathname}`)
    if (!route) return new Response('not found', { status: 404 })
    return route.handler(req)
  }) as typeof fetch
}

const until = async (cond: () => boolean, ms = 3000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout esperando condição')
    await new Promise(r => setTimeout(r, 5))
  }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const SECRET = 'segredo-de-teste-renovacao-signed-state'
const servers: LiveServer[] = []
const connections: LiveConnection[] = []

afterEach(async () => {
  for (const c of connections.splice(0)) c.destroy()
  for (const s of servers.splice(0)) await s.shutdown()
  vi.restoreAllMocks()
})

async function startServer(renewInterval: number | undefined = 100, extra: StateSignatureConfig = {}) {
  const transport = new MemoryTransport()
  const server = new LiveServer({
    transport,
    components: [Tally as never, Other as never, SharedTally as never],
    httpPrefix: false,
    sse: { heartbeatMs: 0 },
    stateSignature: { secret: SECRET, ...extra, ...(renewInterval === undefined ? {} : { renewInterval }) },
  })
  servers.push(server)
  await server.start()
  return { server, transport }
}

async function connect(transport: MemoryTransport): Promise<LiveConnection> {
  const conn = new LiveConnection({
    url: 'ws://app.test/api/live/ws',
    transport: (ep) => new SseClientTransport(ep.sseUrl, { fetch: transport.fetch }),
    heartbeatInterval: 60_000,
  })
  connections.push(conn)
  await until(() => conn.state.connected && !!conn.state.connectionId)
  return conn
}

/** Monta e passa a coletar as mensagens do componente. */
async function mountTally(conn: LiveConnection, component = 'Tally') {
  const mounted = readMountResult(await conn.sendMessageAndWait(clientMessages.mount(undefined, { component })))
  expect(mounted?.signedState).toBeDefined()
  const received: WebSocketResponse[] = []
  conn.registerComponent(mounted!.componentId, (msg) => received.push(msg))
  const signatures = () => received.map(readStateSignature).filter((s): s is SignedState => !!s)
  return { mounted: mounted!, received, signatures }
}

/** Estado dentro do signedState (sem compressão/cripto nos testes: data é JSON). */
const stateOf = (s: SignedState) => JSON.parse(s.data) as Record<string, unknown>

async function rehydrate(conn: LiveConnection, oldId: string, signedState: SignedState, component = 'Tally') {
  const res = await conn.sendMessageAndWait(clientMessages.rehydrate(oldId, { component, signedState }))
  const newId = readRehydrateResult(res)!.newComponentId
  const received: WebSocketResponse[] = []
  conn.registerComponent(newId, (msg) => received.push(msg))
  return { newId, rehydrated: received.map(readStateRehydrated).find(Boolean) }
}

describe('signedState renovado após deltas (STATE_SIGNATURE)', () => {
  it('re-hidrata no estado MAIS RECENTE (5), não no do mount (0) — mesma instância de servidor', async () => {
    const { transport } = await startServer(100)
    const conn = await connect(transport)
    const { mounted, signatures } = await mountTally(conn)

    for (let i = 0; i < 5; i++) await conn.sendMessageAndWait(clientMessages.callAction(mounted.componentId, 'increment'))

    // A renovação (trailing) chega com o estado final da rajada.
    await until(() => signatures().some(s => stateOf(s).count === 5))
    const latest = signatures()[signatures().length - 1]
    expect(stateOf(latest).count).toBe(5)
    expect(stateOf(latest).__componentName).toBe('Tally')
    expect(latest.version).toBeGreaterThan(mounted.signedState!.version)

    // Queda de rede: nova conexão, o componente antigo morre no servidor.
    const oldConnectionId = conn.state.connectionId
    conn.reconnect()
    await until(() => conn.state.connected && !!conn.state.connectionId && conn.state.connectionId !== oldConnectionId)

    const { newId, rehydrated } = await rehydrate(conn, mounted.componentId, latest)
    expect(rehydrated?.state.count).toBe(5)
    const action = await conn.sendMessageAndWait(clientMessages.callAction(newId, 'increment'))
    expect(action.result).toBe(6)
  })

  it('re-hidrata no estado mais recente num SERVIDOR NOVO (restart, mesmo segredo)', async () => {
    const first = await startServer(100)
    const conn = await connect(first.transport)
    const { mounted, signatures } = await mountTally(conn)
    for (let i = 0; i < 5; i++) await conn.sendMessageAndWait(clientMessages.callAction(mounted.componentId, 'increment'))
    await until(() => signatures().some(s => stateOf(s).count === 5))
    const latest = signatures()[signatures().length - 1]

    conn.destroy()
    await first.server.shutdown()
    servers.splice(servers.indexOf(first.server), 1)

    const second = await startServer(100)
    const conn2 = await connect(second.transport)
    const { newId, rehydrated } = await rehydrate(conn2, mounted.componentId, latest)
    expect(rehydrated?.state.count).toBe(5)
    const action = await conn2.sendMessageAndWait(clientMessages.callAction(newId, 'increment'))
    expect(action.result).toBe(6)
  })

  it('throttle: uma rajada de deltas gera poucas assinaturas (leading + trailing), a última com o estado final', async () => {
    const { server, transport } = await startServer(300)
    const conn = await connect(transport)
    const { mounted, signatures, received } = await mountTally(conn)
    const signSpy = vi.spyOn(server.stateSignature, 'signState')

    // 30 actions fire-and-forget: 30 STATE_DELTA em sequência rápida.
    for (let i = 0; i < 30; i++) {
      void conn.sendMessage(clientMessages.callAction(mounted.componentId, 'increment', {}, false))
    }
    await until(() => received.some(m => m.type === 'STATE_DELTA' && (m.payload as { delta: { count?: number } }).delta.count === 30))
    await until(() => signatures().some(s => stateOf(s).count === 30), 2000)
    await sleep(350) // janela seguinte: nada de novo a assinar

    const deltas = received.filter(m => m.type === 'STATE_DELTA').length
    expect(deltas).toBe(30)
    expect(signSpy.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(signSpy.mock.calls.length).toBeLessThanOrEqual(3)
    expect(signatures().length).toBe(signSpy.mock.calls.length)
    expect(stateOf(signatures()[signatures().length - 1]).count).toBe(30)
  })

  it('sem mudança de estado não há renovação (componente ocioso não gasta HMAC)', async () => {
    const { transport } = await startServer(50)
    const conn = await connect(transport)
    const { signatures } = await mountTally(conn)
    await sleep(200)
    expect(signatures()).toHaveLength(0)
  })

  it('renewInterval: 0 desliga a renovação (comportamento antigo)', async () => {
    const { transport } = await startServer(0)
    const conn = await connect(transport)
    const { mounted, signatures } = await mountTally(conn)
    for (let i = 0; i < 3; i++) await conn.sendMessageAndWait(clientMessages.callAction(mounted.componentId, 'increment'))
    await sleep(150)
    expect(signatures()).toHaveLength(0)
  })

  it('assinatura renovada ADULTERADA continua recusada', async () => {
    const { transport } = await startServer(50)
    const conn = await connect(transport)
    const { mounted, signatures } = await mountTally(conn)
    for (let i = 0; i < 5; i++) await conn.sendMessageAndWait(clientMessages.callAction(mounted.componentId, 'increment'))
    await until(() => signatures().some(s => stateOf(s).count === 5))
    const latest = signatures()[signatures().length - 1]

    // Troca count 5 → 500 mantendo a assinatura.
    const forgedData = JSON.stringify({ ...stateOf(latest), count: 500 })
    await expect(
      conn.sendMessageAndWait(clientMessages.rehydrate(mounted.componentId, { component: 'Tally', signedState: { ...latest, data: forgedData } })),
    ).rejects.toThrow(/Invalid signature/)
    // Versão/timestamp alterados também quebram o HMAC.
    await expect(
      conn.sendMessageAndWait(clientMessages.rehydrate(mounted.componentId, { component: 'Tally', signedState: { ...latest, version: latest.version + 10 } })),
    ).rejects.toThrow(/Invalid signature/)
    // Assinatura válida de Tally apresentada como outra classe → __componentName barra.
    await expect(
      conn.sendMessageAndWait(clientMessages.rehydrate(mounted.componentId, { component: 'Other', signedState: latest })),
    ).rejects.toThrow(/mismatch/)
  })

  it('singleton: a renovação vai (uma assinatura) para todas as conexões', async () => {
    const { server, transport } = await startServer(100)
    const a = await connect(transport)
    const b = await connect(transport)
    const ma = await mountTally(a, 'SharedTally')
    const mb = await mountTally(b, 'SharedTally')
    expect(mb.mounted.componentId).toBe(ma.mounted.componentId)
    const signSpy = vi.spyOn(server.stateSignature, 'signState')

    for (let i = 0; i < 4; i++) await a.sendMessageAndWait(clientMessages.callAction(ma.mounted.componentId, 'increment'))
    await until(() => ma.signatures().some(s => stateOf(s).count === 4) && mb.signatures().some(s => stateOf(s).count === 4))
    await sleep(150)
    // Assinado uma vez por janela, não uma vez por conexão.
    expect(signSpy.mock.calls.length).toBe(ma.signatures().length)
    expect(mb.signatures().length).toBe(ma.signatures().length)
  })

  it('com nonce + criptografia + compressão ligados: renovação continua re-hidratável (skipNonce) e adulteração recusada', async () => {
    class Big extends LiveComponent<{ count: number; blob: string }> {
      static componentName = 'Big'
      static defaultState = { count: 0, blob: 'x'.repeat(4000) } // > 1KB → gzip
      static publicActions = ['increment'] as const
      increment() { this.state.count += 1; return this.state.count }
    }
    const transport = new MemoryTransport()
    const server = new LiveServer({
      transport,
      components: [Big as never],
      httpPrefix: false,
      sse: { heartbeatMs: 0 },
      stateSignature: { secret: SECRET, renewInterval: 50, nonceEnabled: true, encryptionEnabled: true, compressionEnabled: true },
    })
    servers.push(server)
    await server.start()
    const conn = await connect(transport)
    const { mounted, signatures } = await mountTally(conn, 'Big')
    for (let i = 0; i < 5; i++) await conn.sendMessageAndWait(clientMessages.callAction(mounted.componentId, 'increment'))
    await until(() => signatures().length > 0 && server.stateSignature.extractData(signatures()[signatures().length - 1]).count === 5)
    const latest = signatures()[signatures().length - 1]
    expect(latest.encrypted).toBe(true)
    expect(latest.compressed).toBe(true)
    expect(latest.nonce).toBeTruthy()

    const oldConnectionId = conn.state.connectionId
    conn.reconnect()
    await until(() => conn.state.connected && !!conn.state.connectionId && conn.state.connectionId !== oldConnectionId)
    const { rehydrated } = await rehydrate(conn, mounted.componentId, latest, 'Big')
    expect(rehydrated?.state.count).toBe(5)

    // Ciphertext adulterado: HMAC recusa antes de decifrar.
    const i = latest.data.length - 3
    const flipped = latest.data.slice(0, i) + (latest.data[i] === 'A' ? 'B' : 'A') + latest.data.slice(i + 1)
    expect(flipped).not.toBe(latest.data)
    await expect(
      conn.sendMessageAndWait(clientMessages.rehydrate(mounted.componentId, { component: 'Big', signedState: { ...latest, data: flipped } })),
    ).rejects.toThrow(/Invalid signature/)
  })

  it('LiveComponentHandle (client vanilla) expõe sempre o signedState mais recente', async () => {
    const { transport } = await startServer(50)
    const conn = await connect(transport)
    const handle = new LiveComponentHandle<{ count: number }>(conn, 'Tally', { autoMount: false })
    await handle.mount()
    const mountSigned = handle.signedState
    expect(mountSigned).toBeTruthy()
    expect(stateOf(mountSigned!).count).toBe(0)

    for (let i = 0; i < 3; i++) await handle.call('increment')
    await until(() => !!handle.signedState && stateOf(handle.signedState).count === 3)
    expect(handle.signedState!.version).toBeGreaterThan(mountSigned!.version)
    handle.destroy()
  })
})
