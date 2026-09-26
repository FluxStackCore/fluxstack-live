// ComponentRegistry — renovação throttled do signedState (STATE_SIGNATURE).
// Fluxo ponta a ponta (LiveServer + LiveConnection reais) em
// __tests__/integration/signed-state-renewal.test.ts.
import { describe, it, expect, afterEach } from 'vitest'
import { ComponentRegistry } from '../../component/ComponentRegistry'
import { LiveComponent } from '../../component/LiveComponent'
import { StateSignatureManager, type SignedState } from '../../security/StateSignature'
import { LiveAuthManager } from '../../auth/LiveAuthManager'
import { createMockWS } from '../helpers'

class Counter extends LiveComponent<{ count: number }> {
  static componentName = 'Counter'
  static defaultState = { count: 0 }
  static publicActions = ['bump', 'bumpBinary'] as const
  bump(payload: { n?: number } = {}) {
    for (let i = 0; i < (payload.n ?? 1); i++) this.state.count += 1
  }
  bumpBinary() {
    this.sendBinaryDelta({ count: this.state.count + 1 }, (d) => new TextEncoder().encode(JSON.stringify(d)))
  }
}

const registries: ComponentRegistry[] = []
afterEach(() => { for (const r of registries.splice(0)) r.cleanup() })

function setup(renewInterval: number) {
  const stateSignature = new StateSignatureManager({ secret: 'test-secret-32chars-minimum-ok!', renewInterval })
  const registry = new ComponentRegistry({
    authManager: new LiveAuthManager(),
    stateSignature,
    performanceMonitor: {
      initializeComponent: () => {},
      recordRenderTime: () => {},
      recordActionTime: () => {},
      removeComponent: () => {},
    } as never,
  })
  registries.push(registry)
  registry.registerComponentClass('Counter', Counter as never)
  return { registry, stateSignature }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Mensagens JSON enviadas ao ws (o batcher pode mandar arrays). */
function jsonMessages(ws: { _messages: string[] }): Array<{ type: string; payload?: { signedState?: SignedState } }> {
  const out: Array<{ type: string; payload?: { signedState?: SignedState } }> = []
  for (const raw of ws._messages) {
    try {
      const parsed = JSON.parse(raw)
      for (const m of Array.isArray(parsed) ? parsed : [parsed]) out.push(m)
    } catch { /* frame binário */ }
  }
  return out
}
const signaturesOf = (ws: { _messages: string[] }) =>
  jsonMessages(ws).filter(m => m.type === 'STATE_SIGNATURE').map(m => m.payload!.signedState!)

describe('ComponentRegistry — renovação do signedState', () => {
  it('rajada de deltas → assinaturas throttled com versão crescente e estado final', async () => {
    const { registry, stateSignature } = setup(40)
    const ws = createMockWS()
    const { componentId } = await registry.mountComponent(ws, 'Counter')
    await registry.executeAction(componentId, 'bump', { n: 10 })
    await sleep(0)
    await registry.executeAction(componentId, 'bump', { n: 5 })
    await sleep(80)

    const sigs = signaturesOf(ws)
    expect(sigs.length).toBeGreaterThanOrEqual(1)
    expect(sigs.length).toBeLessThanOrEqual(2)
    const last = sigs[sigs.length - 1]
    expect(stateSignature.validateState(last, { skipNonce: true }).valid).toBe(true)
    expect(stateSignature.extractData(last)).toMatchObject({ count: 15, __componentName: 'Counter' })
    const versions = sigs.map(s => s.version)
    expect(versions[0]).toBeGreaterThan(1) // mount assinou a versão 1
    expect([...versions].sort((a, b) => a - b)).toEqual(versions)
  })

  it('delta binário (sendBinaryDelta) também dispara a renovação', async () => {
    const { registry, stateSignature } = setup(20)
    const ws = createMockWS()
    const { componentId } = await registry.mountComponent(ws, 'Counter')
    await registry.executeAction(componentId, 'bumpBinary', {})
    await sleep(60)
    const sigs = signaturesOf(ws)
    expect(sigs).toHaveLength(1)
    expect(stateSignature.extractData(sigs[0]).count).toBe(1)
  })

  it('unmount cancela a renovação pendente', async () => {
    const { registry } = setup(50)
    const ws = createMockWS()
    const { componentId } = await registry.mountComponent(ws, 'Counter')
    await registry.executeAction(componentId, 'bump', {}) // agenda (janela aberta pelo mount)
    registry.unmountComponent(componentId, ws)
    await sleep(100)
    expect(signaturesOf(ws)).toHaveLength(0)
  })

  it('re-hidratação renova a partir da versão re-hidratada', async () => {
    const { registry, stateSignature } = setup(20)
    const ws1 = createMockWS()
    const mounted = await registry.mountComponent(ws1, 'Counter')
    await registry.executeAction(mounted.componentId, 'bump', { n: 3 })
    await sleep(50)
    const renewed = signaturesOf(ws1).pop()!
    registry.cleanupConnection(ws1)

    const ws2 = createMockWS()
    const res = await registry.rehydrateComponent(mounted.componentId, 'Counter', renewed, ws2)
    expect(res.success).toBe(true)
    await registry.executeAction(res.newComponentId!, 'bump', {})
    await sleep(50)
    const after = signaturesOf(ws2)
    expect(after.length).toBe(1)
    expect(after[0].version).toBeGreaterThan(renewed.version + 1) // rehydrate = v+1, renovação = v+2
    expect(stateSignature.extractData(after[0]).count).toBe(4)
  })

  it('renewInterval 0: nenhuma renovação', async () => {
    const { registry } = setup(0)
    const ws = createMockWS()
    const { componentId } = await registry.mountComponent(ws, 'Counter')
    await registry.executeAction(componentId, 'bump', { n: 3 })
    await sleep(40)
    expect(signaturesOf(ws)).toHaveLength(0)
  })
})
