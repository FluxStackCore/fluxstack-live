// O servidor renova o signedState de forma throttled (`STATE_SIGNATURE`).
// O hook precisa PERSISTIR a assinatura mais recente — é o que a re-hidratação
// reenvia; com a do mount o componente voltaria ao estado inicial.
//
// Sem infra de render (sem react-dom) travamos por estrutura, como em
// protocol-messages.test.ts; o fluxo real (servidor + LiveConnection) está em
// __tests__/integration/signed-state-renewal.test.ts.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const HOOK_SRC = readFileSync(join(__dirname, '..', 'hooks', 'useLiveComponent.ts'), 'utf-8')

/** Corpo do `case '<type>': { ... }` no switch de mensagens do hook. */
function caseBody(type: string): string {
  const start = HOOK_SRC.indexOf(`case '${type}': {`)
  expect(start, `hook deve tratar ${type}`).toBeGreaterThan(-1)
  const end = HOOK_SRC.indexOf('\n        case ', start + 1)
  return HOOK_SRC.slice(start, end === -1 ? undefined : end)
}

describe('useLiveComponent — renovação do signedState', () => {
  it('trata STATE_SIGNATURE lendo com readStateSignature e persistindo', () => {
    const body = caseBody('STATE_SIGNATURE')
    expect(body).toMatch(/readStateSignature\(message\)/)
    expect(body).toMatch(/persistSigned\(/)
  })

  it('continua persistindo a assinatura de STATE_UPDATE e STATE_REHYDRATED', () => {
    expect(caseBody('STATE_UPDATE')).toMatch(/persistSigned\(update\.signedState\)/)
    expect(caseBody('STATE_REHYDRATED')).toMatch(/persistSigned\(rehydrated\.signedState\)/)
  })

  it('rehydrate reenvia o que está persistido (a assinatura mais recente)', () => {
    expect(HOOK_SRC).toMatch(/signedState:\s*persisted\.signedState/)
  })
})
