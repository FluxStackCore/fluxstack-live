// Validação de forma das mensagens cliente → servidor (protocol/validation.ts).
//
// Duas camadas:
//   1. parseClientMessage isolado — cada tipo com payload certo/errado.
//   2. LiveServer real — frame malformado vira ERROR 'Invalid message: ...'
//      (com requestId ecoado), nunca exceção nem crash.

import { describe, it, expect, expectTypeOf, beforeEach, afterEach } from 'vitest'
import { parseClientMessage, isSignedState, isRecord } from '../../protocol/validation'
import type { ClientMessage } from '../../protocol/messages'
import { LiveServer } from '../../server/LiveServer'
import { LiveComponent } from '../../component/LiveComponent'
import type { InferComponentState, InferPrivateState, ActionNames } from '../../component/types'
import { createMockWS, spyOnConsole } from '../helpers'
import type { LiveTransport, WebSocketConfig, GenericWebSocket } from '../../transport/types'

const signedState = {
  data: 'eyJ9',
  signature: 'abc',
  timestamp: Date.now(),
  version: 1,
  componentId: 'c-1',
}

function expectInvalid(raw: unknown, errorPart?: string) {
  const r = parseClientMessage(raw)
  expect(r.ok).toBe(false)
  if (!r.ok) {
    expect(r.reason).toBe('invalid')
    if (errorPart && r.reason === 'invalid') expect(r.error).toContain(errorPart)
  }
  return r
}

function expectValid(raw: unknown): ClientMessage {
  const r = parseClientMessage(raw)
  if (!r.ok) throw new Error(`esperava válida: ${JSON.stringify(r)}`)
  return r.message
}

describe('parseClientMessage — envelope', () => {
  it('rejeita valores que não são objeto', () => {
    for (const raw of [null, 42, 'x', [1, 2], true, undefined]) expectInvalid(raw, 'expected object')
  })

  it('rejeita type ausente ou não-string', () => {
    expectInvalid({}, 'missing type')
    expectInvalid({ type: 7 }, 'missing type')
  })

  it('rejeita campos de envelope com tipo errado (e ecoa só requestId string)', () => {
    const r = expectInvalid({ type: 'COMPONENT_UNMOUNT', componentId: 123, requestId: 'r1' }, 'componentId')
    if (!r.ok) expect(r.envelope).toEqual({ componentId: undefined, requestId: 'r1' })
    expectInvalid({ type: 'COMPONENT_UNMOUNT', componentId: 'c', requestId: { x: 1 } }, 'requestId')
    expectInvalid({ type: 'CALL_ACTION', componentId: 'c', action: 'a', expectResponse: 'yes' }, 'expectResponse')
  })

  it('tipo desconhecido não é "invalid": vira unknown-type (resposta antiga preservada)', () => {
    const r = parseClientMessage({ type: 'COMPONENT_PING', componentId: 'c', requestId: 'r' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('unknown-type')
      expect(r.envelope.requestId).toBe('r')
    }
  })
})

describe('parseClientMessage — por tipo', () => {
  it('COMPONENT_MOUNT exige payload.component string; props objeto', () => {
    expectInvalid({ type: 'COMPONENT_MOUNT' }, 'requires payload')
    expectInvalid({ type: 'COMPONENT_MOUNT', payload: { component: 1 } }, 'payload.component')
    expectInvalid({ type: 'COMPONENT_MOUNT', payload: { component: 'X', props: 'nope' } }, 'payload.props')
    expectInvalid({ type: 'COMPONENT_MOUNT', payload: { component: 'X', room: 5 } }, 'payload.room')
    const m = expectValid({ type: 'COMPONENT_MOUNT', payload: { component: 'X', props: { a: 1 }, debugLabel: 'd' } })
    expect(m).toMatchObject({ type: 'COMPONENT_MOUNT', payload: { component: 'X', props: { a: 1 }, debugLabel: 'd' } })
  })

  it('COMPONENT_UNMOUNT exige componentId', () => {
    expectInvalid({ type: 'COMPONENT_UNMOUNT' }, 'componentId')
    expect(expectValid({ type: 'COMPONENT_UNMOUNT', componentId: 'c' }).type).toBe('COMPONENT_UNMOUNT')
  })

  it('COMPONENT_REHYDRATE exige component + signedState bem formado', () => {
    expectInvalid({ type: 'COMPONENT_REHYDRATE', componentId: 'c', payload: { component: 'X' } }, 'signedState')
    expectInvalid({ type: 'COMPONENT_REHYDRATE', componentId: 'c', payload: { component: 'X', signedState: { ...signedState, version: '1' } } }, 'signedState')
    // Cliente que manda `componentName` em vez de `component` é recusado com erro claro.
    expectInvalid({ type: 'COMPONENT_REHYDRATE', componentId: 'c', payload: { componentName: 'X', signedState } }, 'payload.component')
    const m = expectValid({ type: 'COMPONENT_REHYDRATE', componentId: 'c', payload: { component: 'X', signedState } })
    expect(m.type).toBe('COMPONENT_REHYDRATE')
  })

  it('CALL_ACTION exige componentId e action string; payload é livre', () => {
    expectInvalid({ type: 'CALL_ACTION', componentId: 'c' }, 'action')
    expectInvalid({ type: 'CALL_ACTION', componentId: 'c', action: 42 }, 'action')
    expectInvalid({ type: 'CALL_ACTION', action: 'x' }, 'componentId')
    for (const payload of [undefined, 1, 'x', [1], { a: 1 }, null]) {
      const m = expectValid({ type: 'CALL_ACTION', componentId: 'c', action: 'go', payload })
      expect(m).toMatchObject({ type: 'CALL_ACTION', action: 'go' })
    }
  })

  it('PROPERTY_UPDATE exige property string e payload objeto', () => {
    expectInvalid({ type: 'PROPERTY_UPDATE', componentId: 'c', payload: { value: 1 } }, 'property')
    expectInvalid({ type: 'PROPERTY_UPDATE', componentId: 'c', property: 'p' }, 'payload.value')
    expectInvalid({ type: 'PROPERTY_UPDATE', componentId: 'c', property: 'p', payload: 5 }, 'payload.value')
    const m = expectValid({ type: 'PROPERTY_UPDATE', componentId: 'c', property: 'p', payload: { value: 5 } })
    expect(m).toMatchObject({ property: 'p', payload: { value: 5 } })
  })

  it('AUTH aceita payload ausente ou objeto', () => {
    expect(expectValid({ type: 'AUTH' }).type).toBe('AUTH')
    expect(expectValid({ type: 'AUTH', payload: { token: 't' } }).type).toBe('AUTH')
    expectInvalid({ type: 'AUTH', payload: 'token' }, 'AUTH payload')
  })

  it('ROOM_*: roomId no topo ou em payload; EMIT exige event; STATE_SET exige state objeto', () => {
    expectInvalid({ type: 'ROOM_JOIN', componentId: 'c' }, 'roomId')
    expectInvalid({ type: 'ROOM_JOIN', componentId: 'c', roomId: 7 }, 'roomId')
    expectInvalid({ type: 'ROOM_JOIN', roomId: 'r' }, 'componentId')
    expect(expectValid({ type: 'ROOM_JOIN', componentId: 'c', roomId: 'r' })).toMatchObject({ roomId: 'r' })
    expect(expectValid({ type: 'ROOM_LEAVE', componentId: 'c', payload: { roomId: 'r2' } })).toMatchObject({ roomId: 'r2' })

    expectInvalid({ type: 'ROOM_EMIT', componentId: 'c', roomId: 'r' }, 'payload.event')
    expectInvalid({ type: 'ROOM_EMIT', componentId: 'c', roomId: 'r', payload: { event: 1 } }, 'payload.event')
    expect(expectValid({ type: 'ROOM_EMIT', componentId: 'c', roomId: 'r', payload: { event: 'e', data: 1 } }))
      .toMatchObject({ payload: { event: 'e', data: 1 } })

    expectInvalid({ type: 'ROOM_STATE_SET', componentId: 'c', roomId: 'r', payload: { state: [1] } }, 'payload.state')
    expectInvalid({ type: 'ROOM_STATE_SET', componentId: 'c', roomId: 'r', payload: 'x' }, 'room payload')
    expect(expectValid({ type: 'ROOM_STATE_SET', componentId: 'c', roomId: 'r', payload: { state: { a: 1 } } }).type).toBe('ROOM_STATE_SET')
  })

  it('FILE_UPLOAD_*: só o envelope é checado (campos ficam para o FileUploadManager)', () => {
    const m = expectValid({ type: 'FILE_UPLOAD_START', componentId: 'c', uploadId: 5, filename: {}, requestId: 'r' })
    expect(m).toMatchObject({ type: 'FILE_UPLOAD_START', uploadId: 5, requestId: 'r' })
    expectInvalid({ type: 'FILE_UPLOAD_CHUNK', componentId: 9 }, 'componentId')
  })
})

describe('type-guards auxiliares', () => {
  it('isRecord / isSignedState', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord([])).toBe(false)
    expect(isRecord(null)).toBe(false)
    expect(isSignedState(signedState)).toBe(true)
    expect(isSignedState({ ...signedState, nonce: 1 })).toBe(false)
    expect(isSignedState({ ...signedState, compressed: 'yes' })).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// LiveServer: frames malformados → ERROR, nunca crash
// ─────────────────────────────────────────────────────────────────────────

class Probe extends LiveComponent<{ n: number }> {
  static componentName = 'Probe'
  static defaultState = { n: 0 }
  static publicActions = ['bump'] as const
  bump(payload: unknown) {
    this.setState({ n: this.state.n + 1 })
    return { got: payload }
  }
}

async function startServer() {
  let onMessage: WebSocketConfig['onMessage'] | undefined
  const transport: LiveTransport = {
    async registerWebSocket(c: WebSocketConfig) { onMessage = c.onMessage },
    async registerHttpRoutes() {},
  }
  const server = new LiveServer({ transport, components: [Probe], rateLimitMaxTokens: 10_000, httpPrefix: false })
  await server.start()
  const send = async (ws: GenericWebSocket, raw: string) => {
    if (!onMessage) throw new Error('not started')
    await onMessage(ws, raw, false)
  }
  return { server, send }
}

function replies(ws: ReturnType<typeof createMockWS>): Array<Record<string, unknown>> {
  return ws._messages.map(m => JSON.parse(m) as Record<string, unknown>)
}

describe('LiveServer — mensagens malformadas', () => {
  let consoleSpy: ReturnType<typeof spyOnConsole>
  let server: LiveServer
  beforeEach(() => { consoleSpy = spyOnConsole() })
  afterEach(async () => {
    consoleSpy?.restore()
    await server?.shutdown()
  })

  const malformed: Array<[string, Record<string, unknown>]> = [
    ['mount sem payload', { type: 'COMPONENT_MOUNT', requestId: 'm1' }],
    ['mount com component numérico', { type: 'COMPONENT_MOUNT', payload: { component: 123 }, requestId: 'm2' }],
    ['mount com props string', { type: 'COMPONENT_MOUNT', payload: { component: 'Probe', props: 'x' }, requestId: 'm3' }],
    ['action sem nome', { type: 'CALL_ACTION', componentId: 'c', requestId: 'm4' }],
    ['property update sem payload', { type: 'PROPERTY_UPDATE', componentId: 'c', property: 'n', requestId: 'm5' }],
    ['rehydrate com signedState lixo', { type: 'COMPONENT_REHYDRATE', componentId: 'c', payload: { component: 'Probe', signedState: 'x' }, requestId: 'm6' }],
    ['room emit sem event', { type: 'ROOM_EMIT', componentId: 'c', roomId: 'r', payload: {}, requestId: 'm7' }],
    ['room join com roomId objeto', { type: 'ROOM_JOIN', componentId: 'c', roomId: { a: 1 }, requestId: 'm8' }],
    ['auth com payload string', { type: 'AUTH', payload: 'tok', requestId: 'm9' }],
    ['componentId numérico', { type: 'COMPONENT_UNMOUNT', componentId: 1, requestId: 'm10' }],
  ]

  for (const [label, frame] of malformed) {
    it(`${label} → ERROR 'Invalid message' com requestId`, async () => {
      const started = await startServer()
      server = started.server
      const ws = createMockWS()
      await expect(started.send(ws, JSON.stringify(frame))).resolves.toBeUndefined()
      const reply = replies(ws).find(r => r.requestId === frame.requestId)
      expect(reply).toBeDefined()
      expect(reply!.type).toBe('ERROR')
      expect(reply!.success).toBe(false)
      expect(String(reply!.error)).toMatch(/^Invalid message: /)
    })
  }

  it('tipo desconhecido continua respondendo MESSAGE_RESPONSE "Unknown message type"', async () => {
    const started = await startServer()
    server = started.server
    const ws = createMockWS()
    await started.send(ws, JSON.stringify({ type: 'COMPONENT_PING', componentId: 'c', requestId: 'u1' }))
    const reply = replies(ws).find(r => r.requestId === 'u1')
    expect(reply).toMatchObject({ type: 'MESSAGE_RESPONSE', success: false, error: 'Unknown message type' })
  })

  it('depois de mensagens ruins, a conexão segue funcionando (mount + action)', async () => {
    const started = await startServer()
    server = started.server
    const ws = createMockWS()
    await started.send(ws, '{"type":"CALL_ACTION"}')
    await started.send(ws, '{"type":"COMPONENT_MOUNT","payload":{"component":"Probe"},"requestId":"ok1"}')
    const mount = replies(ws).find(r => r.requestId === 'ok1')
    expect(mount).toMatchObject({ type: 'MESSAGE_RESPONSE', success: true })
    const cid = (mount!.result as { componentId: string }).componentId
    await started.send(ws, JSON.stringify({ type: 'CALL_ACTION', componentId: cid, action: 'bump', payload: { x: 1 }, expectResponse: true, requestId: 'ok2' }))
    expect(replies(ws).find(r => r.requestId === 'ok2')).toMatchObject({ type: 'ACTION_RESPONSE', success: true, result: { got: { x: 1 } } })
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Utilitários de tipo (checagem em tempo de compilação)
// ─────────────────────────────────────────────────────────────────────────

interface ProbePrivate { secret: string }
class WithPrivate extends LiveComponent<{ n: number }, ProbePrivate> {
  static componentName = 'WithPrivate'
  static defaultState = { n: 0 }
  async go(_p: { x: number }) { return 1 }
}

describe('utilitários de tipo', () => {
  it('inferem state/private mesmo com TPrivate sendo interface', () => {
    expectTypeOf<InferComponentState<WithPrivate>>().toEqualTypeOf<{ n: number }>()
    expectTypeOf<InferPrivateState<WithPrivate>>().toEqualTypeOf<ProbePrivate>()
    expectTypeOf<ActionNames<WithPrivate>>().toEqualTypeOf<'go'>()
  })
})
