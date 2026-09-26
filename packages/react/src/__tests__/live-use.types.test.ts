// Contrato de TIPOS do `Live.use()` — checado pelo tsc do pacote
// (`bun x tsc -p packages/react/tsconfig.json --noEmit`). Em runtime o teste
// só confirma que o arquivo carrega; o valor está nas asserções de tipo.
//
// Trava a inferência a partir da classe do servidor: estado, actions públicas
// (e SÓ as públicas), `$room<Room>()` tipado e `$field`/`$set` por chave.

import { describe, it, expect } from 'vitest'
import type { LiveComponent, LiveRoom } from '@fluxstack/live'
import type { Live } from '../components/Live'
import type { FieldBinding } from '../hooks/useLiveComponent'

type Equal<A, B> = (<G>() => G extends A ? 1 : 2) extends (<G>() => G extends B ? 1 : 2) ? true : false
type Expect<T extends true> = T

interface CounterState { count: number; label: string }

declare class ChatRoom extends LiveRoom<{ topic: string }, Record<string, unknown>, { msg: { text: string }; typing: { user: string } }> {}

declare class Counter extends LiveComponent<CounterState> {
  static componentName: string
  static defaultState: CounterState
  static publicActions: readonly ['increment', 'rename']
  increment(payload: { by?: number }): Promise<number>
  rename(payload: { label: string }): Promise<void>
  /** não está em publicActions → não pode aparecer no proxy */
  secret(): Promise<string>
}

type CounterProxy = ReturnType<typeof Live.use<typeof Counter>>

type _state = Expect<Equal<CounterProxy['$state'], CounterState>>
type _field = Expect<Equal<CounterProxy['count'], number>>
type _incParams = Expect<Equal<Parameters<CounterProxy['increment']>, [payload: { by?: number }]>>
type _incReturn = Expect<Equal<ReturnType<CounterProxy['increment']>, Promise<number>>>
type _renameReturn = Expect<Equal<ReturnType<CounterProxy['rename']>, Promise<void>>>
type _noSecret = Expect<Equal<'secret' extends keyof CounterProxy ? true : false, false>>
type _fieldBinding = Expect<Equal<ReturnType<CounterProxy['$field']>, FieldBinding>>
type _setKey = Expect<Equal<Parameters<CounterProxy['$set']>[0], keyof CounterState>>

// $room<Room>(id): eventos e estado inferidos da LiveRoom (brand `$events`).
// Função nunca chamada: só o tsc olha para o corpo.
function _roomTypes(proxy: CounterProxy) {
  const handle = proxy.$room<ChatRoom>('chat:lobby')
  handle.on('msg', (data) => {
    type _msg = Expect<Equal<typeof data, { text: string }>>
  })
  // @ts-expect-error — evento inexistente na sala
  handle.on('nao-existe', () => {})
  type _roomState = Expect<Equal<typeof handle.state, { topic: string }>>
}
void _roomTypes

describe('Live.use() — contrato de tipos', () => {
  it('compila (asserções verificadas pelo tsc)', () => {
    expect(true).toBe(true)
  })
})
