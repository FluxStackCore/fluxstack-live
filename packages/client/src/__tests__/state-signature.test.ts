// readStateSignature — leitor da renovação throttled do signedState
// (`STATE_SIGNATURE { signedState }`). O fluxo ponta a ponta (servidor real +
// LiveConnection real + LiveComponentHandle.signedState) está em
// __tests__/integration/signed-state-renewal.test.ts.
import { describe, it, expect } from 'vitest'
import type { WebSocketResponse } from '@fluxstack/live'
import { readStateSignature } from '../protocol'

const signed = { data: '{"count":5}', signature: 'abc', timestamp: 1, version: 3, componentId: 'c1' }

describe('readStateSignature', () => {
  it('lê payload.signedState de STATE_SIGNATURE', () => {
    const msg: WebSocketResponse = { type: 'STATE_SIGNATURE', componentId: 'c1', payload: { signedState: signed } }
    expect(readStateSignature(msg)).toEqual(signed)
  })

  it('ignora outros tipos de mensagem', () => {
    const msg: WebSocketResponse = { type: 'STATE_UPDATE', componentId: 'c1', payload: { state: {}, signedState: signed } }
    expect(readStateSignature(msg)).toBeNull()
  })

  it('recusa forma inválida (payload vindo do fio é não confiável)', () => {
    const bad = [
      undefined,
      { signedState: null },
      { signedState: { ...signed, version: '3' } },
      { signedState: { ...signed, signature: undefined } },
    ]
    for (const payload of bad) {
      expect(readStateSignature({ type: 'STATE_SIGNATURE', componentId: 'c1', payload })).toBeNull()
    }
  })
})
