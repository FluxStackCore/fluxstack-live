// Testes da reconexão resiliente (commit 4f03f4a):
//  - retry infinito por padrão (não desiste após N tentativas)
//  - reconecta em window 'online' e visibilitychange -> visible
//  - disconnect() intencional NÃO dispara auto-reconnect
//
// Environment é 'node' (sem DOM real), então mockamos WebSocket + window/document
// capturando os event listeners para dispará-los manualmente.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LiveConnection } from '../connection'

class MockWebSocket {
  static instances: MockWebSocket[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readyState = 0
  binaryType = 'arraybuffer'
  onopen: ((ev?: any) => void) | null = null
  onclose: ((ev?: any) => void) | null = null
  onerror: ((ev?: any) => void) | null = null
  onmessage: ((ev?: any) => void) | null = null
  send = vi.fn()
  close = vi.fn(function (this: MockWebSocket) {
    this.readyState = 3
    this.onclose?.({ code: 1006, reason: 'network' }) // 1006 = queda anormal
  })
  constructor(public url: string) {
    MockWebSocket.instances.push(this)
  }
  /** helper: simula o servidor aceitando a conexão */
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  /** helper: simula queda de rede (sem ser intencional) */
  drop(code = 1006) {
    this.readyState = 3
    this.onclose?.({ code, reason: 'dropped' })
  }
}

// Captura de listeners de window/document para disparar manualmente.
const winListeners: Record<string, Array<() => void>> = {}
const docListeners: Record<string, Array<() => void>> = {}
let visibilityState: 'visible' | 'hidden' = 'visible'

function fireWindow(event: string) {
  for (const h of winListeners[event] ?? []) h()
}
function fireDocument(event: string) {
  for (const h of docListeners[event] ?? []) h()
}

beforeEach(() => {
  MockWebSocket.instances = []
  for (const k of Object.keys(winListeners)) delete winListeners[k]
  for (const k of Object.keys(docListeners)) delete docListeners[k]
  visibilityState = 'visible'
  ;(globalThis as any).WebSocket = MockWebSocket
  ;(globalThis as any).window = {
    addEventListener: (ev: string, h: () => void) => {
      (winListeners[ev] ??= []).push(h)
    },
    removeEventListener: (ev: string, h: () => void) => {
      winListeners[ev] = (winListeners[ev] ?? []).filter((x) => x !== h)
    },
    location: { protocol: 'http:', host: 'test' },
  }
  ;(globalThis as any).document = {
    addEventListener: (ev: string, h: () => void) => {
      (docListeners[ev] ??= []).push(h)
    },
    removeEventListener: (ev: string, h: () => void) => {
      docListeners[ev] = (docListeners[ev] ?? []).filter((x) => x !== h)
    },
    get visibilityState() {
      return visibilityState
    },
  }
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as any).window
  delete (globalThis as any).document
})

describe('LiveConnection — reconexão resiliente', () => {
  it('retry infinito por padrão: não desiste após muitas tentativas', () => {
    const conn = new LiveConnection({ url: 'ws://test', autoConnect: false, reconnectInterval: 1000 })
    conn.connect()
    MockWebSocket.instances[0].open()

    // Simula 20 quedas seguidas (mais que o antigo limite de 5).
    for (let i = 0; i < 20; i++) {
      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]
      ws.drop()
      vi.advanceTimersByTime(16000) // passa do backoff (teto 16s)
    }

    // Deve ter criado MUITAS conexões (1 inicial + 20 reconexões), não parado em 5.
    expect(MockWebSocket.instances.length).toBeGreaterThan(10)
    // E não deve ter setado o erro fatal "Max reconnection attempts reached".
    expect(conn.state.error).not.toBe('Max reconnection attempts reached')
    conn.destroy()
  })

  it('limite finito ainda funciona (compat): desiste após maxReconnectAttempts', () => {
    const conn = new LiveConnection({ url: 'ws://test', autoConnect: false, reconnectInterval: 1000, maxReconnectAttempts: 3 })
    conn.connect()
    MockWebSocket.instances[0].open()

    for (let i = 0; i < 10; i++) {
      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]
      ws.drop()
      vi.advanceTimersByTime(16000)
    }
    // 1 inicial + 3 tentativas = no máximo 4 conexões.
    expect(MockWebSocket.instances.length).toBeLessThanOrEqual(4)
    expect(conn.state.error).toBe('Max reconnection attempts reached')
    conn.destroy()
  })

  it("reconecta ao voltar 'online' (sem esperar o backoff)", () => {
    const conn = new LiveConnection({ url: 'ws://test', autoConnect: false, reconnectInterval: 1000 })
    conn.connect()
    MockWebSocket.instances[0].open()
    MockWebSocket.instances[0].drop() // cai
    const afterDrop = MockWebSocket.instances.length

    // Sem avançar o tempo, dispara 'online' → deve reconectar IMEDIATAMENTE.
    fireWindow('online')
    expect(MockWebSocket.instances.length).toBe(afterDrop + 1)
    conn.destroy()
  })

  it('reconecta quando a aba volta a ficar visível', () => {
    const conn = new LiveConnection({ url: 'ws://test', autoConnect: false })
    conn.connect()
    MockWebSocket.instances[0].open()
    MockWebSocket.instances[0].drop()
    const afterDrop = MockWebSocket.instances.length

    visibilityState = 'visible'
    fireDocument('visibilitychange')
    expect(MockWebSocket.instances.length).toBe(afterDrop + 1)
    conn.destroy()
  })

  it("'online' com WS já aberto é no-op (não duplica conexão)", () => {
    const conn = new LiveConnection({ url: 'ws://test', autoConnect: false })
    conn.connect()
    MockWebSocket.instances[0].open()
    expect(MockWebSocket.instances).toHaveLength(1)

    fireWindow('online') // já conectado → connect() guarda contra OPEN
    expect(MockWebSocket.instances).toHaveLength(1)
    conn.destroy()
  })

  it('disconnect() intencional NÃO dispara auto-reconnect', () => {
    const conn = new LiveConnection({ url: 'ws://test', autoConnect: false })
    conn.connect()
    MockWebSocket.instances[0].open()

    conn.disconnect() // fecha de propósito
    vi.advanceTimersByTime(60000) // tempo de sobra p/ qualquer backoff

    // Nenhuma reconexão automática após disconnect intencional.
    expect(MockWebSocket.instances).toHaveLength(1)
    conn.destroy()
  })

  it('destroy() remove os listeners de online/visibility', () => {
    const conn = new LiveConnection({ url: 'ws://test', autoConnect: false })
    conn.connect()
    MockWebSocket.instances[0].open()
    conn.destroy()

    const before = MockWebSocket.instances.length
    fireWindow('online')
    fireDocument('visibilitychange')
    // Após destroy, eventos não criam conexões.
    expect(MockWebSocket.instances.length).toBe(before)
  })
})
