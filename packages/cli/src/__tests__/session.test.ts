// Lógica do inspector sem terminal: args, config, delta de estado, comandos
// (frames enviados + mensagens de uso), rastreio de mensagens recebidas e
// decodificação/formatação de frames binários 0x01/0x02/0x03.
import { describe, it, expect } from 'vitest'
import { buildRoomFrame, msgpackCodec } from '@fluxstack/live'
import { InspectorSession, parseArgs, resolveConfig, applyStateDelta, helpText, type InspectorConfig } from '../session'
import { decodeBinaryFrame, BINARY_STATE_DELTA } from '../msgpack'
import { formatBinaryFrame, formatMessage, type WireMessage } from '../format'

// eslint-disable-next-line no-control-regex
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

function makeSession(overrides: Partial<InspectorConfig> = {}, fetchImpl?: typeof fetch) {
  const sent: Array<Record<string, unknown>> = []
  const lines: string[] = []
  let cleared = 0
  const session = new InspectorSession(
    { ...resolveConfig({}), ...overrides },
    {
      send: (text) => sent.push(JSON.parse(text) as Record<string, unknown>),
      log: (line) => lines.push(strip(line)),
      fetch: fetchImpl,
      clear: () => { cleared++ },
    },
  )
  return { session, sent, lines, output: () => lines.join('\n'), cleared: () => cleared }
}

/** Simula a resposta do servidor a um COMPONENT_MOUNT enviado pela sessão. */
function answerMount(s: ReturnType<typeof makeSession>, componentId: string, initialState: Record<string, unknown>) {
  const req = s.sent.at(-1)!
  s.session.handleMessage(JSON.stringify({
    type: 'MESSAGE_RESPONSE',
    requestId: req.requestId,
    success: true,
    result: { componentId, initialState, signedState: {} },
  }))
}

describe('parseArgs / resolveConfig', () => {
  it('lê --flag valor, --flag=valor e flags booleanas', () => {
    // posicional solto (sem flag antes) é ignorado
    expect(parseArgs(['solto', '--url', 'ws://x/api/live/ws', '--filter=STATE_DELTA', '--raw', '--quiet'])).toEqual({
      url: 'ws://x/api/live/ws', filter: 'STATE_DELTA', raw: true, quiet: true,
    })
  })

  it('flag seguida de outra flag vira booleana', () => {
    expect(parseArgs(['--raw', '--url', 'u'])).toEqual({ raw: true, url: 'u' })
  })

  it('padrões e URLs derivadas', () => {
    expect(resolveConfig({})).toEqual({
      wsUrl: 'ws://localhost:3000/api/live/ws',
      statsUrl: 'http://localhost:3000/api/live/stats',
      componentsUrl: 'http://localhost:3000/api/live/components',
      filter: undefined,
      raw: false,
      quiet: false,
      interactive: true,
    })
  })

  it('wss → https; --stats-url explícito; --no-interactive', () => {
    const cfg = resolveConfig(parseArgs(['--url', 'wss://app.io/api/live/ws', '--no-interactive']))
    expect(cfg.statsUrl).toBe('https://app.io/api/live/stats')
    expect(cfg.interactive).toBe(false)
    expect(resolveConfig({ 'stats-url': 'http://h/custom/stats' }).componentsUrl).toBe('http://h/custom/components')
  })
})

describe('applyStateDelta', () => {
  it('null no topo é valor; null aninhado remove; objetos mesclam; arrays substituem', () => {
    const state: Record<string, unknown> = { a: 1, owner: 'x', nested: { k: 1, gone: true }, list: [1, 2] }
    applyStateDelta(state, { owner: null, nested: { gone: null, novo: 2 }, list: [3], skip: undefined })
    expect(state).toEqual({ a: 1, owner: null, nested: { k: 1, novo: 2 }, list: [3] })
  })

  it('ignora delta que não é objeto', () => {
    const state = { a: 1 }
    applyStateDelta(state, null)
    applyStateDelta(state, 5)
    expect(state).toEqual({ a: 1 })
  })
})

describe('InspectorSession — comandos', () => {
  it('mount envia COMPONENT_MOUNT com requestId e rastreia a resposta real do servidor', () => {
    const s = makeSession()
    s.session.execCommand('mount Counter {"count": 5}')
    expect(s.sent[0]).toMatchObject({ type: 'COMPONENT_MOUNT', payload: { component: 'Counter', props: { count: 5 } }, expectResponse: true })
    expect(typeof s.sent[0].requestId).toBe('string')

    answerMount(s, 'cmp-1', { count: 5 })
    expect(s.session.activeComponentId).toBe('cmp-1')
    expect(s.session.mountedComponents.get('cmp-1')).toEqual({ name: 'Counter', state: { count: 5 } })
    expect(s.output()).toContain('componente montado: Counter (cmp-1)')
  })

  it('mount que falha não vira componente ativo', () => {
    const s = makeSession()
    s.session.execCommand('mount Nope')
    s.session.handleMessage(JSON.stringify({ type: 'MESSAGE_RESPONSE', requestId: s.sent[0].requestId, success: false, error: 'not found' }))
    expect(s.session.activeComponentId).toBe('')
  })

  it('compat: MESSAGE_RESPONSE com originalType=COMPONENT_MOUNT', () => {
    const s = makeSession()
    s.session.handleMessage(JSON.stringify({ type: 'MESSAGE_RESPONSE', originalType: 'COMPONENT_MOUNT', result: { componentId: 'c9', componentName: 'Old', state: { v: 1 } } }))
    expect(s.session.mountedComponents.get('c9')).toEqual({ name: 'Old', state: { v: 1 } })
  })

  it('action envia CALL_ACTION para o componente ativo pedindo resposta', () => {
    const s = makeSession()
    s.session.execCommand('mount Counter')
    answerMount(s, 'cmp-1', {})
    s.session.execCommand('action increment {"by": 2}')
    expect(s.sent.at(-1)).toMatchObject({ type: 'CALL_ACTION', componentId: 'cmp-1', action: 'increment', payload: { by: 2 }, expectResponse: true })
    s.session.execCommand('call reset')
    expect(s.sent.at(-1)).toMatchObject({ action: 'reset', payload: {} })
  })

  it('STATE_DELTA / STATE_UPDATE atualizam o estado mostrado por `state`', () => {
    const s = makeSession()
    s.session.execCommand('mount Counter')
    answerMount(s, 'cmp-1', { count: 0, meta: { a: 1 } })
    s.session.handleMessage(JSON.stringify([
      { type: 'STATE_DELTA', componentId: 'cmp-1', payload: { delta: { count: 3, meta: { b: 2 } } } },
    ]))
    expect(s.session.mountedComponents.get('cmp-1')!.state).toEqual({ count: 3, meta: { a: 1, b: 2 } })

    s.session.handleMessage(JSON.stringify({ type: 'STATE_UPDATE', componentId: 'cmp-1', payload: { state: { count: 10 } } }))
    expect(s.session.mountedComponents.get('cmp-1')!.state).toEqual({ count: 10 })

    s.lines.length = 0
    s.session.execCommand('state')
    expect(s.output()).toContain('[state] Counter (cmp-1)')
    expect(s.output()).toContain('"count": 10')
  })

  it('room join/leave/emit usam o formato que o servidor aceita (event/data em payload)', () => {
    const s = makeSession()
    s.session.execCommand('mount Chat')
    answerMount(s, 'cmp-1', {})
    s.session.execCommand('room join sala-1')
    expect(s.sent.at(-1)).toMatchObject({ type: 'ROOM_JOIN', componentId: 'cmp-1', roomId: 'sala-1' })
    s.session.execCommand('room emit sala-1 msg {"text": "oi"}')
    expect(s.sent.at(-1)).toMatchObject({ type: 'ROOM_EMIT', roomId: 'sala-1', payload: { event: 'msg', data: { text: 'oi' } } })
    expect(s.sent.at(-1)).not.toHaveProperty('event')
    s.session.execCommand('room leave sala-1')
    expect(s.sent.at(-1)).toMatchObject({ type: 'ROOM_LEAVE', roomId: 'sala-1' })
  })

  it('auth e send', () => {
    const s = makeSession()
    s.session.execCommand('auth {"token": "t"}')
    expect(s.sent.at(-1)).toMatchObject({ type: 'AUTH', payload: { token: 't' } })
    s.session.execCommand('send {"type": "PING"}')
    expect(s.sent.at(-1)).toEqual({ type: 'PING' })
  })

  it('unmount remove e troca o ativo para o próximo montado', () => {
    const s = makeSession()
    s.session.execCommand('mount A')
    answerMount(s, 'a1', {})
    s.session.execCommand('mount B')
    answerMount(s, 'b1', {})
    expect(s.session.activeComponentId).toBe('b1')
    s.session.execCommand('unmount')
    expect(s.sent.at(-1)).toMatchObject({ type: 'COMPONENT_UNMOUNT', componentId: 'b1' })
    expect(s.session.activeComponentId).toBe('a1')
    s.session.execCommand('unmount')
    expect(s.session.activeComponentId).toBe('')
  })

  it('use troca o ativo por prefixo; cid lista todos', () => {
    const s = makeSession()
    s.session.execCommand('mount A')
    answerMount(s, 'aaa-111', {})
    s.session.execCommand('mount B')
    answerMount(s, 'bbb-222', {})
    s.session.execCommand('use aaa')
    expect(s.session.activeComponentId).toBe('aaa-111')
    s.lines.length = 0
    s.session.execCommand('cid')
    expect(s.output()).toContain('A (aaa-111) *')
    expect(s.output()).toContain('B (bbb-222)')
    s.session.execCommand('use zzz')
    expect(s.output()).toContain('componentId nao encontrado: zzz')
  })

  it.each([
    ['mount', 'uso: mount'],
    ['action x', 'nenhum componente montado'],
    ['action', 'uso: action'],
    ['unmount', 'nenhum componente montado'],
    ['state', 'nenhum componente montado ou cid invalido'],
    ['room join', 'uso: room join'],
    ['room join r1', 'nenhum componente montado'],
    ['room emit r1', 'uso: room emit'],
    ['room xyz', 'uso: room [join|leave|emit]'],
    ['mount X {ruim', 'props JSON invalido'],
    ['auth {ruim', 'payload JSON invalido'],
    ['send nada', 'JSON invalido'],
    ['use', 'uso: use'],
    ['voar', 'comando desconhecido: voar'],
  ])('`%s` sem os requisitos avisa e não envia', async (cmd, msg) => {
    const s = makeSession()
    await s.session.execCommand(cmd)
    expect(s.sent).toHaveLength(0)
    expect(s.output()).toContain(msg)
  })

  it('help, info, clear, linha vazia e quit', async () => {
    const s = makeSession()
    await s.session.execCommand('help')
    expect(s.output()).toContain('Comandos disponíveis')
    expect(strip(helpText())).toContain('room emit')
    s.session.handleMessage('{"type":"PONG"}')
    await s.session.execCommand('info')
    expect(s.output()).toMatch(/mensagens:\s+1/)
    await s.session.execCommand('clear')
    expect(s.cleared()).toBe(1)
    expect(await s.session.execCommand('   ')).toBeUndefined()
    expect(await s.session.execCommand('quit')).toBe('quit')
    expect(await s.session.execCommand('EXIT')).toBe('quit')
  })

  it('stats / components via fetch (e erro de rede)', async () => {
    const fake = (async (url: string | URL | Request) => {
      if (String(url).endsWith('/stats')) return new Response(JSON.stringify({ components: 3 }))
      if (String(url).endsWith('/components')) return new Response(JSON.stringify(['Counter', 'Chat']))
      throw new Error('offline')
    }) as typeof fetch
    const s = makeSession({}, fake)
    await s.session.execCommand('stats')
    await s.session.execCommand('components')
    expect(s.output()).toContain('"components": 3')
    expect(s.output()).toContain('- Counter')

    const broken = makeSession({ statsUrl: 'http://x/quebrado' }, fake)
    await broken.session.execCommand('stats')
    expect(broken.output()).toContain('falha ao buscar stats: offline')
  })

  it('filtro e quiet silenciam linhas mas não o rastreio', () => {
    const s = makeSession({ filter: 'ERROR', quiet: true })
    s.session.handleMessage('{"type":"PONG"}')
    s.session.handleMessage('{"type":"STATE_UPDATE","componentId":"c1","payload":{"state":{"x":1}}}')
    expect(s.lines).toEqual([])
    expect(s.session.mountedComponents.get('c1')!.state).toEqual({ x: 1 })
    expect(s.session.msgCount).toBe(2)
  })

  it('JSON inválido é ignorado', () => {
    const s = makeSession()
    s.session.handleMessage('não é json')
    expect(s.session.msgCount).toBe(0)
    expect(s.session.byteCount).toBeGreaterThan(0)
  })
})

describe('frames binários', () => {
  it('0x02 / 0x03 (salas, msgpack) — frames gerados pelo core', () => {
    const ev = decodeBinaryFrame(buildRoomFrame(0x02, 'cmp-1', 'sala', 'chat:msg', msgpackCodec.encode({ text: 'olá', n: -3, ok: true, f: 1.5 })))
    expect(ev).toEqual({ frameType: 0x02, componentId: 'cmp-1', roomId: 'sala', event: 'chat:msg', data: { text: 'olá', n: -3, ok: true, f: 1.5 } })

    const st = decodeBinaryFrame(buildRoomFrame(0x03, 'cmp-1', 'sala', '$state:update', msgpackCodec.encode({ users: { u1: null }, list: [1, 2] })))
    expect(st).toMatchObject({ frameType: 0x03, event: '$state:update', data: { users: { u1: null }, list: [1, 2] } })
  })

  it('0x01 (delta binário de componente): [0x01][idLen][id][payload], sem sala/evento', () => {
    const id = new TextEncoder().encode('cmp-xyz')
    const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x07])
    const frame = new Uint8Array([BINARY_STATE_DELTA, id.length, ...id, ...payload])
    const decoded = decodeBinaryFrame(frame)
    expect(decoded).toEqual({ frameType: 0x01, componentId: 'cmp-xyz', roomId: '', event: '', data: payload })

    const line = strip(formatBinaryFrame(decoded!, {})!)
    expect(line).toContain('BIN_STATE_DELTA')
    expect(line).toContain('cid: cmp-xyz')
    expect(line).toContain('payload: 6 bytes  de ad be ef 00 07')
    expect(line).not.toContain('room:')
  })

  it('frames truncados/curtos → null', () => {
    expect(decodeBinaryFrame(new Uint8Array([]))).toBeNull()
    expect(decodeBinaryFrame(new Uint8Array([0x01, 10, 65]))).toBeNull() // idLen além do buffer
    expect(decodeBinaryFrame(new Uint8Array([0x02, 1, 65, 200, 0, 0]))).toBeNull() // roomIdLen além do buffer
    const noEvent = buildRoomFrame(0x02, 'c', 'r', 'evento-longo', new Uint8Array())
    expect(decodeBinaryFrame(noEvent.subarray(0, noEvent.length - 3))).toBeNull()
  })

  it('formatação: rótulos por tipo e filtro BINARY', () => {
    const f = decodeBinaryFrame(buildRoomFrame(0x03, 'c', 'r', 'e', msgpackCodec.encode({ a: 1 })))!
    expect(strip(formatBinaryFrame(f, {})!)).toContain('BIN_ROOM_STATE')
    expect(formatBinaryFrame(f, { filter: 'BINARY' })).not.toBeNull()
    expect(formatBinaryFrame(f, { filter: 'BIN_ROOM_STATE' })).not.toBeNull()
    expect(formatBinaryFrame(f, { filter: 'STATE_DELTA' })).toBeNull()
    expect(strip(formatBinaryFrame({ ...f, frameType: 0x7f }, {})!)).toContain('BIN_0x7f')
  })

  it('a sessão conta e exibe frames binários (Uint8Array e ArrayBuffer)', () => {
    const s = makeSession()
    const frame = buildRoomFrame(0x02, 'c', 'sala', 'ping', msgpackCodec.encode({ x: 1 }))
    s.session.handleMessage(frame)
    s.session.handleMessage(frame.slice().buffer)
    expect(s.session.msgCount).toBe(2)
    expect(s.session.byteCount).toBe(frame.byteLength * 2)
    expect(s.output()).toContain('BIN_ROOM_EVENT')
    expect(s.output()).toContain('room: sala  event: ping')
  })
})

describe('formatMessage', () => {
  it('mostra caminhos do delta e limita a 15', () => {
    const delta = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]))
    const out = strip(formatMessage({ type: 'STATE_DELTA', componentId: 'c', payload: { delta: { nested: { a: 1 }, ...delta } } }, 'IN', {})!)
    expect(out).toContain('Δ nested.a = 1')
    expect(out).toContain('... +6 more')
  })

  it('raw imprime o JSON inteiro', () => {
    const out = strip(formatMessage({ type: 'X', a: 1 }, 'OUT', { raw: true })!)
    expect(out).toContain('▲ OUT')
    expect(out).toContain('"a": 1')
  })

  it.each([
    [{ type: 'CONNECTION_ESTABLISHED', connectionId: 'conn-1' }, 'connectionId: conn-1'],
    [{ type: 'ACTION_RESPONSE', componentId: 'c', result: 3 }, 'result: 3'],
    [{ type: 'ERROR', error: 'boom' }, 'boom'],
    [{ type: 'ROOM_EVENT', roomId: 'r', event: 'e', data: { a: 1 } }, 'room: r  event: e'],
    [{ type: 'ROOM_EMIT', roomId: 'r', payload: { event: 'e2', data: { b: 2 } } }, 'event: e2'],
    [{ type: 'AUTH_RESPONSE', success: false }, 'success: false'],
    [{ type: 'COMPONENT_MOUNT', payload: { component: 'Counter', props: { a: 1 } } }, 'component: Counter'],
    [{ type: 'MESSAGE_RESPONSE', success: false, error: 'nope' }, 'error: nope'],
  ])('%o', (msg, expected) => {
    // result de ACTION_RESPONSE pode ser primitivo (WireResult é só o formato de objeto)
    expect(strip(formatMessage(msg as unknown as WireMessage, 'IN', {})!)).toContain(expected)
  })
})
