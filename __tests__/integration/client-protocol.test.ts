// Protocolo cliente ⇄ servidor, ponta a ponta:
//   LiveServer real (sse)  ⇄  LiveConnection/RoomManager reais (transport sse)
// ligados por um `fetch` em memória (mesmo esquema de sse-transport.test.ts).
//
// Cobre as divergências achadas na tipagem do core (ver
// .ai-notes/bugs/2026-09-26-divergencias-protocolo-cliente-servidor.md):
//   - ROOM_EMIT / ROOM_STATE_SET iam com event/data/state no topo → o servidor
//     (que lê `payload`) recusava com ERROR 'Invalid message'.
//   - ROOM_JOIN mandava initialState em `data` (ignorado) e o client esperava
//     `success`/`state` no topo da resposta (o servidor manda ROOM_JOINED com
//     `payload.state`) → `joined` nunca virava true.
//   - COMPONENT_REHYDRATE ia com `payload.componentName`; o servidor lê
//     `payload.component` → re-hidratação nunca funcionou.
//   - STATE_REHYDRATED chega ANTES da resposta (flush do batcher) para um
//     componentId que o cliente ainda não conhece → era descartado.
import { describe, it, expect, afterEach } from 'vitest'
import { LiveServer } from '../../packages/core/src/server/LiveServer'
import { LiveComponent } from '../../packages/core/src/component/LiveComponent'
import { parseClientMessage } from '../../packages/core/src/protocol/validation'
import type { ClientMessage, WebSocketResponse } from '../../packages/core/src/protocol/messages'
import type { LiveTransport, RawHttpRoute, WebSocketConfig } from '../../packages/core/src/transport/types'
import { LiveConnection } from '../../packages/client/src/connection'
import { SseClientTransport } from '../../packages/client/src/transports'
import { RoomManager, type RoomServerMessage } from '../../packages/client/src/rooms'
import { ChunkedUploader } from '../../packages/client/src/upload'
import {
  clientMessages,
  readMountResult,
  readRehydrateResult,
  readStateRehydrated,
  isRecord,
  type OutgoingClientMessage,
} from '../../packages/client/src/protocol'

// ===== Compatibilidade de tipos (checada por tsc, não em runtime) =====
// Toda mensagem que o cliente gera (menos o heartbeat) precisa caber em
// `ClientMessage`, o tipo que o servidor produz depois de validar.
type NonHeartbeat = Exclude<OutgoingClientMessage, { type: 'PING' }>
const _clientMessagesMatchServer: (m: NonHeartbeat) => ClientMessage = (m) => m
void _clientMessagesMatchServer

// ===== Componentes de teste =====

class RoomUser extends LiveComponent<{ name: string }> {
  static componentName = 'RoomUser'
  static defaultState = { name: '' }
  static publicActions = [] as const
}

class Tally extends LiveComponent<{ count: number }> {
  static componentName = 'Tally'
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

let server: LiveServer | null = null
const connections: LiveConnection[] = []

afterEach(async () => {
  for (const c of connections.splice(0)) c.destroy()
  await server?.shutdown()
  server = null
})

/** Arquivos "gravados" pelo servidor nos testes de upload (sem tocar o disco). */
const assembled: Array<{ filename: string; bytes: number }> = []

async function startServer() {
  const transport = new MemoryTransport()
  server = new LiveServer({
    transport,
    components: [RoomUser as never, Tally as never],
    httpPrefix: false,
    sse: { heartbeatMs: 0 },
    fileUpload: {
      assembleFile: async (upload) => {
        let bytes = 0
        for (const chunk of upload.receivedChunks.values()) {
          bytes += typeof chunk === 'string' ? Buffer.from(chunk, 'base64').length : chunk.length
        }
        assembled.push({ filename: upload.filename, bytes })
        return `/uploads/${upload.filename}`
      },
    },
  })
  await server.start()
  return transport
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

/** Monta um componente e liga um RoomManager nele (como o hook do React faz). */
async function mountWithRooms(conn: LiveConnection, component: string) {
  const res = await conn.sendMessageAndWait(clientMessages.mount(undefined, { component, props: {} }))
  const mounted = readMountResult(res)
  if (!mounted) throw new Error('mount sem componentId')
  const componentId = mounted.componentId

  const roomHandlers = new Set<(msg: RoomServerMessage) => void>()
  const received: WebSocketResponse[] = []
  conn.registerComponent(componentId, (msg) => {
    received.push(msg)
    if (msg.type.startsWith('ROOM_')) {
      for (const h of roomHandlers) h(msg as unknown as RoomServerMessage)
    }
  })

  const rooms = new RoomManager<{ topic?: string }, { chat: { text: string } }>({
    componentId,
    sendMessage: (m) => conn.sendMessage(m),
    sendMessageAndWait: (m, t) => conn.sendMessageAndWait(m, t),
    onMessage: (h) => { roomHandlers.add(h); return () => { roomHandlers.delete(h) } },
    onBinaryMessage: (h) => conn.registerRoomBinaryHandler(h),
  })
  return { componentId, rooms, received }
}

const errorsOf = (received: WebSocketResponse[]) => received.filter(m => m.type === 'ERROR').map(m => m.error)

// ===== Builders × validador real do servidor =====

describe('clientMessages passam no validador do servidor', () => {
  const signedState = {
    data: 'e30=', signature: 'x', timestamp: Date.now(), version: 1, componentId: 'c1',
  }
  const cases: Array<[string, OutgoingClientMessage]> = [
    ['COMPONENT_MOUNT', clientMessages.mount('tmp', { component: 'Tally', props: { count: 1 }, room: 'r' })],
    ['COMPONENT_UNMOUNT', clientMessages.unmount('c1')],
    ['COMPONENT_REHYDRATE', clientMessages.rehydrate('c1', { component: 'Tally', signedState })],
    ['CALL_ACTION', clientMessages.callAction('c1', 'increment', { by: 1 })],
    ['CALL_ACTION (fire)', clientMessages.callAction('c1', 'increment', undefined, false)],
    ['PROPERTY_UPDATE', clientMessages.propertyUpdate('c1', 'count', 3)],
    ['AUTH', clientMessages.auth({ token: 't' })],
    ['ROOM_JOIN', clientMessages.roomJoin('c1', 'lobby', { topic: 'x' })],
    ['ROOM_JOIN (sem estado)', clientMessages.roomJoin('c1', 'lobby')],
    ['ROOM_LEAVE', clientMessages.roomLeave('c1', 'lobby')],
    ['ROOM_EMIT', clientMessages.roomEmit('c1', 'lobby', 'chat', { text: 'oi' })],
    ['ROOM_STATE_SET', clientMessages.roomStateSet('c1', 'lobby', { topic: 'y' })],
    ['ROOM_STATE_GET', clientMessages.roomStateGet('c1', 'lobby')],
  ]

  for (const [name, msg] of cases) {
    it(name, () => {
      // Passa pelo mesmo caminho do fio: JSON ida e volta.
      const result = parseClientMessage(JSON.parse(JSON.stringify(msg)))
      expect(result).toMatchObject({ ok: true })
    })
  }

  it('a forma antiga das mensagens de sala é recusada (regressão)', () => {
    const oldEmit = { type: 'ROOM_EMIT', componentId: 'c1', roomId: 'lobby', event: 'chat', data: {} }
    const oldSet = { type: 'ROOM_STATE_SET', componentId: 'c1', roomId: 'lobby', data: { topic: 'y' } }
    const oldRehydrate = { type: 'COMPONENT_REHYDRATE', componentId: 'c1', payload: { componentName: 'Tally', signedState } }
    expect(parseClientMessage(oldEmit)).toMatchObject({ ok: false, reason: 'invalid' })
    expect(parseClientMessage(oldSet)).toMatchObject({ ok: false, reason: 'invalid' })
    expect(parseClientMessage(oldRehydrate)).toMatchObject({ ok: false, reason: 'invalid' })
  })
})

// ===== Salas =====

describe('salas pelo client real (ROOM_JOIN / EMIT / STATE_SET / STATE_GET)', () => {
  it('join com initialState, evento entre clientes e estado compartilhado', async () => {
    const transport = await startServer()
    const alice = await mountWithRooms(await connect(transport), 'RoomUser')
    const bobConn = await connect(transport)
    const bob = await mountWithRooms(bobConn, 'RoomUser')

    // ROOM_JOIN: initialState vai em payload.initialState; resposta ROOM_JOINED marca joined.
    const aliceLobby = alice.rooms.createHandle('lobby')
    await aliceLobby.join({ topic: 'inicial' })
    expect(aliceLobby.joined).toBe(true)

    const bobLobby = bob.rooms.createHandle('lobby')
    await bobLobby.join()
    expect(bobLobby.joined).toBe(true)
    // Bob entra depois: recebe o estado criado pelo initialState da Alice.
    expect(bobLobby.state.topic).toBe('inicial')

    // ROOM_EMIT: Bob recebe o evento emitido pela Alice.
    const chats: Array<{ text: string }> = []
    bobLobby.on('chat', (data) => chats.push(data))
    aliceLobby.emit('chat', { text: 'oi bob' })
    await until(() => chats.length === 1)
    expect(chats[0]).toEqual({ text: 'oi bob' })

    // ROOM_STATE_SET: mudança da Alice chega no estado do Bob.
    const changes: unknown[] = []
    bobLobby.onSystem('state:change', (c) => changes.push(c))
    aliceLobby.setState({ topic: 'novo' })
    await until(() => bobLobby.state.topic === 'novo')
    expect(changes).toContainEqual({ topic: 'novo' })

    // ROOM_STATE_GET: servidor devolve ROOM_STATE com payload.state.
    const res = await bobConn.sendMessageAndWait(clientMessages.roomStateGet(bob.componentId, 'lobby'))
    expect(res.type).toBe('ROOM_STATE')
    expect(isRecord(res.payload) && isRecord(res.payload.state) && res.payload.state.topic).toBe('novo')

    // Nenhuma mensagem foi recusada pelo validador.
    expect(errorsOf(alice.received)).toEqual([])
    expect(errorsOf(bob.received)).toEqual([])

    // ROOM_LEAVE
    await bobLobby.leave()
    expect(bobLobby.joined).toBe(false)
  })

  it('recusa do servidor em ROOM_JOIN rejeita o join (antes resolvia como sucesso)', async () => {
    const transport = await startServer()
    const conn = await connect(transport)
    const alice = await mountWithRooms(conn, 'RoomUser')
    // componentId que não é desta conexão → ERROR 'Component not found' (sem `success`).
    const res = conn.sendMessageAndWait(clientMessages.roomJoin('nao-e-meu', 'lobby'))
    await expect(res).rejects.toThrow('Component not found')
    expect(alice.rooms.createHandle('lobby').joined).toBe(false)
  })
})

// ===== Re-hidratação =====

describe('COMPONENT_REHYDRATE (payload.component)', () => {
  it('monta, reconecta e re-hidrata mantendo o estado assinado', async () => {
    const transport = await startServer()
    const conn = await connect(transport)

    const mountRes = await conn.sendMessageAndWait(clientMessages.mount(undefined, { component: 'Tally', props: { count: 7 } }))
    const mounted = readMountResult(mountRes)
    expect(mounted?.signedState).toBeDefined()
    const oldId = mounted!.componentId
    const signedState = mounted!.signedState!

    // Simula queda de rede: nova conexão (o componente antigo morre no servidor).
    const oldConnectionId = conn.state.connectionId
    conn.reconnect()
    await until(() => conn.state.connected && !!conn.state.connectionId && conn.state.connectionId !== oldConnectionId)

    const res = await conn.sendMessageAndWait(clientMessages.rehydrate(oldId, { component: 'Tally', signedState }))
    expect(res.type).toBe('COMPONENT_REHYDRATED')
    expect(res.success).toBe(true)
    const newId = readRehydrateResult(res)?.newComponentId
    expect(newId).toBeTruthy()
    expect(newId).not.toBe(oldId)

    // STATE_REHYDRATED chegou ANTES da resposta: fica guardado e é entregue no registro.
    const received: WebSocketResponse[] = []
    conn.registerComponent(newId!, (msg) => received.push(msg))
    const rehydrated = received.map(readStateRehydrated).find(Boolean)
    expect(rehydrated?.state.count).toBe(7)
    expect(rehydrated?.newComponentId).toBe(newId)

    // O componente re-hidratado no servidor continua do estado assinado.
    const action = await conn.sendMessageAndWait(clientMessages.callAction(newId!, 'increment'))
    expect(action.result).toBe(8)
  })

  it('assinatura adulterada é recusada (cai para o mount)', async () => {
    const transport = await startServer()
    const conn = await connect(transport)
    const mounted = readMountResult(await conn.sendMessageAndWait(clientMessages.mount(undefined, { component: 'Tally' })))
    const forged = { ...mounted!.signedState!, signature: 'forjada' }
    await expect(
      conn.sendMessageAndWait(clientMessages.rehydrate(mounted!.componentId, { component: 'Tally', signedState: forged })),
    ).rejects.toThrow()
  })
})

// ===== Upload em chunks =====
// O servidor responde FILE_UPLOAD_PROGRESS / FILE_UPLOAD_COMPLETE sem ecoar o
// requestId; o LiveConnection correlaciona por uploadId/chunkIndex. Antes cada
// chunk esperava o timeout (10s) e o upload falhava.

describe('upload em chunks pelo ChunkedUploader real', () => {
  for (const useBinaryProtocol of [false, true]) {
    it(`completa o upload (${useBinaryProtocol ? 'binário' : 'JSON/base64'})`, async () => {
      const transport = await startServer()
      const conn = await connect(transport)
      const mounted = readMountResult(await conn.sendMessageAndWait(clientMessages.mount(undefined, { component: 'Tally' })))

      const progress: number[] = []
      const errors: string[] = []
      let fileUrl: string | undefined
      const uploader = new ChunkedUploader(mounted!.componentId, {
        chunkSize: 16 * 1024,
        useBinaryProtocol,
        // timeout curto: se a correlação quebrar, o teste falha rápido
        sendMessageAndWait: (m) => conn.sendMessageAndWait(m, 1000),
        sendBinaryAndWait: (d, id) => conn.sendBinaryAndWait(d, id, 1000),
        onProgress: (p) => progress.push(p),
        onError: (e) => errors.push(e),
        onComplete: (r) => { fileUrl = r.fileUrl },
      })

      const name = `nota-${useBinaryProtocol ? 'bin' : 'json'}.txt`
      await uploader.uploadFile(new File([new Uint8Array(40_000).fill(65)], name, { type: 'text/plain' }))

      expect(errors).toEqual([])
      expect(progress.length).toBe(3) // 16k + 16k + 8k
      expect(progress.at(-1)).toBe(100)
      expect(fileUrl).toBe(`/uploads/${name}`)
      expect(assembled).toContainEqual({ filename: name, bytes: 40_000 })
    })
  }
})
