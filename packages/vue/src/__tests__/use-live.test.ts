// useLive (useLiveComponent) contra um LiveConnection dirigido por transporte
// fake: mount, sincronização de estado (STATE_UPDATE / STATE_DELTA), actions,
// erros, remount após queda e limpeza no unmount.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { useLive, type UseLiveComponentOptions, type UseLiveComponentReturn } from '../index'
import { mountWithLive, fakeTransportFactory, flush, type FakeTransport, type Mounted } from './harness'

interface TodoState {
  count: number
  label: string | null
  items: Record<string, { done: boolean }>
}

const initial: TodoState = { count: 0, label: 'init', items: {} }

let mounted: Mounted<UseLiveComponentReturn<TodoState>> | null = null
afterEach(() => {
  mounted?.unmount()
  mounted = null
})

function setup(opts: UseLiveComponentOptions = {}) {
  const t = fakeTransportFactory()
  mounted = mountWithLive(
    { transport: t.factory, reconnectInterval: 5, heartbeatInterval: 60_000 },
    () => useLive<TodoState>('Todo', { ...initial, items: {} }, opts),
  )
  return { t, m: mounted, live: mounted.child }
}

/** Responde o COMPONENT_MOUNT pendente como o servidor faria. */
async function answerMount(t: FakeTransport, componentId: string, initialState: Partial<TodoState> = {}) {
  await vi.waitFor(() => expect(t.lastSent('COMPONENT_MOUNT')).toBeDefined())
  const req = t.lastSent('COMPONENT_MOUNT')!
  t.serverSend({
    type: 'MESSAGE_RESPONSE',
    requestId: req.requestId,
    success: true,
    result: { componentId, initialState: { ...initial, ...initialState }, signedState: null },
  })
  await flush()
  return req
}

describe('useLive', () => {
  it('monta ao conectar, com props = estado inicial e room', async () => {
    const { t, live } = setup({ room: 'sala-1' })
    expect(live.mounted.value).toBe(false)
    expect(live.state.count).toBe(0)

    t.current().accept()
    const req = await answerMount(t.current(), 'cmp-1', { count: 7 })
    expect(req.payload).toMatchObject({ component: 'Todo', props: { count: 0, label: 'init' }, room: 'sala-1' })

    expect(live.mounted.value).toBe(true)
    expect(live.mounting.value).toBe(false)
    expect(live.componentId.value).toBe('cmp-1')
    expect(live.state.count).toBe(7)
    expect(live.connected.value).toBe(true)
  })

  it('STATE_UPDATE e STATE_DELTA atualizam o estado reativo (null top-level = valor, aninhado = remoção)', async () => {
    const { t, live } = setup()
    t.current().accept()
    await answerMount(t.current(), 'cmp-1')

    t.current().serverSend({ type: 'STATE_UPDATE', componentId: 'cmp-1', payload: { state: { count: 3, items: { a: { done: false }, b: { done: true } } } } })
    expect(live.state.count).toBe(3)
    expect(Object.keys(live.state.items)).toEqual(['a', 'b'])

    t.current().serverSend({ type: 'STATE_DELTA', componentId: 'cmp-1', payload: { delta: { label: null, items: { a: { done: true }, b: null } } } })
    expect(live.state.label).toBeNull()
    expect('label' in live.state).toBe(true)
    expect(live.state.items).toEqual({ a: { done: true } })
    expect(live.state.count).toBe(3) // intacto

    // mensagens de outro componente são ignoradas
    t.current().serverSend({ type: 'STATE_DELTA', componentId: 'outro', payload: { delta: { count: 999 } } })
    expect(live.state.count).toBe(3)
  })

  it('mensagens que chegam antes do registro (flush antes da resposta) não se perdem', async () => {
    const { t, live } = setup()
    t.current().accept()
    await vi.waitFor(() => expect(t.current().lastSent('COMPONENT_MOUNT')).toBeDefined())
    const req = t.current().lastSent('COMPONENT_MOUNT')!
    // servidor dá flush no delta do onMount ANTES da resposta
    t.current().serverSend({ type: 'STATE_DELTA', componentId: 'cmp-1', payload: { delta: { count: 42 } } })
    t.current().serverSend({ type: 'MESSAGE_RESPONSE', requestId: req.requestId, success: true, result: { componentId: 'cmp-1', initialState: initial } })
    await flush()
    expect(live.state.count).toBe(42)
  })

  it('o estado exposto é somente-leitura', () => {
    const { live } = setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    ;(live.state as { count: number }).count = 99
    expect(live.state.count).toBe(0)
    warn.mockRestore()
  })

  it('call() envia CALL_ACTION e resolve com o resultado', async () => {
    const { t, live } = setup()
    t.current().accept()
    await answerMount(t.current(), 'cmp-1')

    const p = live.call<number>('increment', { by: 2 })
    const msg = t.current().lastSent('CALL_ACTION')!
    expect(msg).toMatchObject({ componentId: 'cmp-1', action: 'increment', payload: { by: 2 }, expectResponse: true })
    t.current().serverSend({ type: 'ACTION_RESPONSE', requestId: msg.requestId, componentId: 'cmp-1', success: true, result: 2 })
    await expect(p).resolves.toBe(2)
  })

  it('call() com falha no servidor rejeita E preenche error', async () => {
    const { t, live } = setup()
    t.current().accept()
    await answerMount(t.current(), 'cmp-1')

    const p = live.call('explode')
    const msg = t.current().lastSent('CALL_ACTION')!
    t.current().serverSend({ type: 'ACTION_RESPONSE', requestId: msg.requestId, success: false, error: 'Action explode failed' })
    await expect(p).rejects.toThrow('Action explode failed')
    expect(live.error.value).toBe('Action explode failed')
  })

  it('call() antes de montar lança', async () => {
    const { live } = setup()
    await expect(live.call('increment')).rejects.toThrow(/not mounted/)
  })

  it('ERROR direcionado ao componente vai para error', async () => {
    const { t, live } = setup()
    t.current().accept()
    await answerMount(t.current(), 'cmp-1')
    t.current().serverSend({ type: 'ERROR', componentId: 'cmp-1', error: 'rate limited' })
    expect(live.error.value).toBe('rate limited')
  })

  it('falha no mount preenche error e permite nova tentativa', async () => {
    const { t, live } = setup()
    t.current().accept()
    await vi.waitFor(() => expect(t.current().lastSent('COMPONENT_MOUNT')).toBeDefined())
    const req = t.current().lastSent('COMPONENT_MOUNT')!
    t.current().serverSend({ type: 'MESSAGE_RESPONSE', requestId: req.requestId, success: false, error: 'Component not found: Todo' })
    await vi.waitFor(() => expect(live.error.value).toBe('Component not found: Todo'))
    expect(live.mounted.value).toBe(false)
    expect(live.mounting.value).toBe(false)

    t.current().sent.length = 0
    const retry = live.mount()
    await answerMount(t.current(), 'cmp-2')
    await retry
    expect(live.mounted.value).toBe(true)
    expect(live.error.value).toBeNull()
  })

  it('autoMount: false só monta com mount() explícito', async () => {
    const { t, live } = setup({ autoMount: false })
    t.current().accept()
    await flush()
    expect(t.current().lastSent('COMPONENT_MOUNT')).toBeUndefined()

    const p = live.mount()
    await answerMount(t.current(), 'cmp-1')
    await p
    expect(live.mounted.value).toBe(true)
  })

  it('mount() desconectado é no-op', async () => {
    const { t, live } = setup({ autoMount: false })
    await live.mount()
    expect(t.current().sent).toHaveLength(0)
    expect(live.mounting.value).toBe(false)
  })

  it('queda de conexão desmonta localmente e remonta ao reconectar', async () => {
    const { t, live } = setup()
    t.current().accept()
    await answerMount(t.current(), 'cmp-1')
    expect(live.mounted.value).toBe(true)

    t.current().drop()
    await flush()
    expect(live.mounted.value).toBe(false)
    expect(live.componentId.value).toBeNull()

    await vi.waitFor(() => expect(t.created).toHaveLength(2))
    t.current().accept()
    await answerMount(t.current(), 'cmp-2', { count: 5 })
    expect(live.mounted.value).toBe(true)
    expect(live.componentId.value).toBe('cmp-2')
    expect(live.state.count).toBe(5)

    // o callback antigo foi desregistrado: mensagem para cmp-1 não afeta o estado
    t.current().serverSend({ type: 'STATE_DELTA', componentId: 'cmp-1', payload: { delta: { count: 1 } } })
    expect(live.state.count).toBe(5)
  })

  it('desmontar o componente Vue envia COMPONENT_UNMOUNT e para de ouvir', async () => {
    const { t, m, live } = setup()
    t.current().accept()
    await answerMount(t.current(), 'cmp-1')

    await m.hideChild()
    await flush()
    expect(t.current().lastSent('COMPONENT_UNMOUNT')).toMatchObject({ componentId: 'cmp-1' })
    expect(live.mounted.value).toBe(false)

    t.current().serverSend({ type: 'STATE_DELTA', componentId: 'cmp-1', payload: { delta: { count: 77 } } })
    expect(live.state.count).toBe(0)
  })

  it('desmontar durante o mount pendente não vaza o componente no servidor', async () => {
    const { t, m, live } = setup()
    t.current().accept()
    await vi.waitFor(() => expect(t.current().lastSent('COMPONENT_MOUNT')).toBeDefined())
    const req = t.current().lastSent('COMPONENT_MOUNT')!

    await m.hideChild() // sai de cena antes da resposta
    t.current().serverSend({ type: 'MESSAGE_RESPONSE', requestId: req.requestId, success: true, result: { componentId: 'cmp-late', initialState: initial } })
    await flush()

    // o composable deve desfazer o mount tardio no servidor
    expect(t.current().lastSent('COMPONENT_UNMOUNT')).toMatchObject({ componentId: 'cmp-late' })
    expect(live.mounted.value).toBe(false)

    // e não fica ouvindo o componente órfão
    t.current().serverSend({ type: 'STATE_DELTA', componentId: 'cmp-late', payload: { delta: { count: 9 } } })
    expect(live.state.count).toBe(0)
  })
})

// ===== Re-hidratação (signedState mais recente → COMPONENT_REHYDRATE) =====

const signed = (version: number, count: number) => ({
  data: JSON.stringify({ count, __componentName: 'Todo' }),
  signature: `sig-${version}`,
  timestamp: Date.now(),
  version,
  componentId: 'cmp-1',
})

/** Mount respondido com signedState (o que o servidor real manda). */
async function answerSignedMount(t: FakeTransport, componentId: string, version = 1) {
  await vi.waitFor(() => expect(t.lastSent('COMPONENT_MOUNT')).toBeDefined())
  const req = t.lastSent('COMPONENT_MOUNT')!
  t.serverSend({
    type: 'MESSAGE_RESPONSE', requestId: req.requestId, success: true,
    result: { componentId, initialState: initial, signedState: signed(version, 0) },
  })
  await flush()
}

/** Derruba o transporte atual e espera o próximo abrir. */
async function dropAndReconnect(t: ReturnType<typeof fakeTransportFactory>) {
  const before = t.created.length
  t.current().drop()
  await flush()
  await vi.waitFor(() => expect(t.created.length).toBe(before + 1))
  t.current().accept()
}

describe('useLive — re-hidratação', () => {
  it('guarda o signedState mais recente (mount → STATE_SIGNATURE) e re-hidrata com ele na reconexão', async () => {
    const { t, live } = setup()
    t.current().accept()
    await answerSignedMount(t.current(), 'cmp-1')
    expect(live.signedState.value?.version).toBe(1)

    t.current().serverSend({ type: 'STATE_DELTA', componentId: 'cmp-1', payload: { delta: { count: 5 } } })
    t.current().serverSend({ type: 'STATE_SIGNATURE', componentId: 'cmp-1', payload: { signedState: signed(2, 5) } })
    expect(live.signedState.value?.version).toBe(2)

    await dropAndReconnect(t)
    await vi.waitFor(() => expect(t.current().lastSent('COMPONENT_REHYDRATE')).toBeDefined())
    const req = t.current().lastSent('COMPONENT_REHYDRATE')!
    expect(live.rehydrating.value).toBe(true)
    expect(req).toMatchObject({ componentId: 'cmp-1', payload: { component: 'Todo', signedState: { version: 2, signature: 'sig-2' } } })
    expect(t.current().lastSent('COMPONENT_MOUNT')).toBeUndefined()

    // Servidor: STATE_REHYDRATED sai antes da resposta (fica no buffer até o registro).
    t.current().serverSend({
      type: 'STATE_REHYDRATED', componentId: 'cmp-2',
      payload: { state: { ...initial, count: 5 }, newComponentId: 'cmp-2', oldComponentId: 'cmp-1', signedState: signed(3, 5) },
    })
    t.current().serverSend({ type: 'COMPONENT_REHYDRATED', componentId: 'cmp-1', requestId: req.requestId, success: true, result: { newComponentId: 'cmp-2' } })
    await flush()

    expect(live.mounted.value).toBe(true)
    expect(live.rehydrating.value).toBe(false)
    expect(live.componentId.value).toBe('cmp-2')
    expect(live.state.count).toBe(5)
    expect(live.signedState.value?.version).toBe(3) // a próxima re-hidratação parte dela
    expect(t.current().lastSent('COMPONENT_MOUNT')).toBeUndefined()
  })

  it('re-hidratação recusada (assinatura inválida) → descarta o token e cai para o mount normal', async () => {
    const { t, live } = setup()
    t.current().accept()
    await answerSignedMount(t.current(), 'cmp-1')

    await dropAndReconnect(t)
    await vi.waitFor(() => expect(t.current().lastSent('COMPONENT_REHYDRATE')).toBeDefined())
    const req = t.current().lastSent('COMPONENT_REHYDRATE')!
    t.current().serverSend({ type: 'COMPONENT_REHYDRATED', componentId: 'cmp-1', requestId: req.requestId, success: false, error: 'Invalid signature' })

    await answerMount(t.current(), 'cmp-2', { count: 0 })
    expect(live.mounted.value).toBe(true)
    expect(live.componentId.value).toBe('cmp-2')
    expect(live.signedState.value).toBeNull() // resposta do mount sem signedState; o recusado foi descartado
    expect(live.error.value).toBeNull()
  })

  it('persistState: false → nunca re-hidrata (reconexão monta do zero)', async () => {
    const { t, live } = setup({ persistState: false })
    t.current().accept()
    await answerSignedMount(t.current(), 'cmp-1')

    await dropAndReconnect(t)
    await answerMount(t.current(), 'cmp-2')
    expect(live.componentId.value).toBe('cmp-2')
    expect(t.created.some((tr) => tr.lastSent('COMPONENT_REHYDRATE'))).toBe(false)
  })

  it('sem signedState recebido → reconexão monta normalmente', async () => {
    const { t, live } = setup()
    t.current().accept()
    await answerMount(t.current(), 'cmp-1') // signedState: null

    await dropAndReconnect(t)
    await answerMount(t.current(), 'cmp-2')
    expect(live.componentId.value).toBe('cmp-2')
    expect(t.current().lastSent('COMPONENT_REHYDRATE')).toBeUndefined()
  })

  it('connectionId novo sem ver connected=false (queda e volta rápidas) também re-hidrata', async () => {
    const { t, live } = setup()
    t.current().accept()
    t.current().serverSend({ type: 'CONNECTION_ESTABLISHED', connectionId: 'conn-A' })
    await answerSignedMount(t.current(), 'cmp-1')
    await flush()

    t.current().serverSend({ type: 'CONNECTION_ESTABLISHED', connectionId: 'conn-B' })
    await vi.waitFor(() => expect(t.current().lastSent('COMPONENT_REHYDRATE')).toBeDefined())
    expect(live.mounted.value).toBe(false)
    expect(t.current().lastSent('COMPONENT_REHYDRATE')).toMatchObject({ componentId: 'cmp-1' })
  })

  it('unmount() explícito esquece o token: o próximo mount começa do zero', async () => {
    const { t, live } = setup()
    t.current().accept()
    await answerSignedMount(t.current(), 'cmp-1')
    await live.unmount()
    expect(live.signedState.value).toBeNull()

    t.current().sent.length = 0
    const p = live.mount()
    await answerMount(t.current(), 'cmp-2')
    await p
    expect(t.current().lastSent('COMPONENT_REHYDRATE')).toBeUndefined()
  })
})

// ===== Persistência entre reloads (localStorage, mesmo comportamento do React) =====

class MemoryStorage {
  store = new Map<string, string>()
  getItem(k: string) { return this.store.get(k) ?? null }
  setItem(k: string, v: string) { this.store.set(k, v) }
  removeItem(k: string) { this.store.delete(k) }
}

describe('useLive — persistência em localStorage', () => {
  let storage: MemoryStorage
  beforeEach(() => {
    storage = new MemoryStorage()
    ;(globalThis as { localStorage?: unknown }).localStorage = storage
  })
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage
  })

  const stored = () => JSON.parse(storage.getItem('fluxstack_component_Todo') ?? 'null') as { signedState: { version: number } } | null

  it('persiste o signedState do mount e cada renovação (mesma chave do React)', async () => {
    const { t } = setup({ room: 'sala-1' })
    t.current().accept()
    await answerSignedMount(t.current(), 'cmp-1')
    expect(stored()?.signedState.version).toBe(1)
    t.current().serverSend({ type: 'STATE_SIGNATURE', componentId: 'cmp-1', payload: { signedState: signed(2, 4) } })
    expect(stored()?.signedState.version).toBe(2)
    expect(stored()).toMatchObject({ componentName: 'Todo', room: 'sala-1' })
  })

  it('após um "reload" re-hidrata a partir do localStorage na primeira conexão', async () => {
    storage.setItem('fluxstack_component_Todo', JSON.stringify({
      componentName: 'Todo', signedState: signed(7, 9), lastUpdate: Date.now(),
    }))
    const { t, live } = setup()
    t.current().accept()
    await vi.waitFor(() => expect(t.current().lastSent('COMPONENT_REHYDRATE')).toBeDefined())
    const req = t.current().lastSent('COMPONENT_REHYDRATE')!
    expect(req.payload).toMatchObject({ component: 'Todo', signedState: { version: 7 } })
    t.current().serverSend({ type: 'STATE_REHYDRATED', componentId: 'cmp-9', payload: { state: { ...initial, count: 9 }, newComponentId: 'cmp-9', signedState: signed(8, 9) } })
    t.current().serverSend({ type: 'COMPONENT_REHYDRATED', requestId: req.requestId, success: true, result: { newComponentId: 'cmp-9' } })
    await vi.waitFor(() => expect(live.state.count).toBe(9))
    expect(stored()?.signedState.version).toBe(8)
  })

  it('token persistido recusado é apagado e o componente monta', async () => {
    storage.setItem('fluxstack_component_Todo', JSON.stringify({
      componentName: 'Todo', signedState: signed(7, 9), lastUpdate: Date.now(),
    }))
    const { t, live } = setup()
    t.current().accept()
    await vi.waitFor(() => expect(t.current().lastSent('COMPONENT_REHYDRATE')).toBeDefined())
    const req = t.current().lastSent('COMPONENT_REHYDRATE')!
    t.current().serverSend({ type: 'COMPONENT_REHYDRATED', requestId: req.requestId, success: false, error: 'State expired' })
    await answerMount(t.current(), 'cmp-1')
    expect(live.mounted.value).toBe(true)
    expect(storage.getItem('fluxstack_component_Todo')).toBeNull()
  })

  it('token persistido com mais de 1 h é ignorado (monta direto)', async () => {
    storage.setItem('fluxstack_component_Todo', JSON.stringify({
      componentName: 'Todo', signedState: signed(7, 9), lastUpdate: Date.now() - 2 * 60 * 60 * 1000,
    }))
    const { t } = setup()
    t.current().accept()
    await answerMount(t.current(), 'cmp-1')
    expect(t.current().lastSent('COMPONENT_REHYDRATE')).toBeUndefined()
  })

  it('persistState: false não grava nem lê localStorage', async () => {
    storage.setItem('fluxstack_component_Todo', JSON.stringify({
      componentName: 'Todo', signedState: signed(7, 9), lastUpdate: Date.now(),
    }))
    const { t } = setup({ persistState: false })
    t.current().accept()
    await answerSignedMount(t.current(), 'cmp-1')
    expect(t.current().lastSent('COMPONENT_REHYDRATE')).toBeUndefined()
    expect(stored()?.signedState.version).toBe(7) // intocado
  })
})
