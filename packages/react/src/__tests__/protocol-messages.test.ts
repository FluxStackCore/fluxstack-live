// O hook do React monta TODAS as mensagens pelo `clientMessages` do
// @fluxstack/live-client, cuja forma é validada contra o servidor real em
// `__tests__/integration/client-protocol.test.ts`.
//
// Sem infra de render (sem react-dom), travamos por estrutura:
//   1. nenhuma mensagem é montada à mão (`type: 'COMPONENT_...'` literal);
//   2. o rehydrate envia `component` (o servidor lê `payload.component`;
//      `componentName` fazia a re-hidratação cair sempre no mount);
//   3. o builder gera a forma que o servidor aceita.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { clientMessages } from '@fluxstack/live-client'

const HOOK_SRC = readFileSync(join(__dirname, '..', 'hooks', 'useLiveComponent.ts'), 'utf-8')

describe('mensagens do useLiveComponent', () => {
  it('não monta mensagens de protocolo à mão', () => {
    const literal = HOOK_SRC.match(/type:\s*'(COMPONENT_\w+|CALL_ACTION|ROOM_\w+|AUTH|PROPERTY_UPDATE)'/g)
    expect(literal).toBeNull()
  })

  it('rehydrate usa o builder com `component: componentName`', () => {
    expect(HOOK_SRC).toMatch(/clientMessages\.rehydrate\([^)]*\{\s*component:\s*componentName/)
    // forma antiga: shorthand `componentName,` logo antes de signedState no payload
    expect(HOOK_SRC).not.toMatch(/^\s+componentName,\s*\r?\n\s*signedState/m)
  })

  it('o builder de rehydrate gera payload.component', () => {
    const signedState = { data: 'e30=', signature: 's', timestamp: 1, version: 1, componentId: 'c1' }
    const msg = clientMessages.rehydrate('c1', { component: 'Counter', signedState })
    expect(msg).toEqual({
      type: 'COMPONENT_REHYDRATE',
      componentId: 'c1',
      payload: { component: 'Counter', signedState },
    })
    expect(msg.payload).not.toHaveProperty('componentName')
  })
})
