// Trava o contrato que sustenta o fix de "componente preso em Offline" ao
// adquirir uma conexão JÁ conectada do pool (commit 7689896):
//
// 1. `.state` reflete o estado ATUAL de forma síncrona (a fonte que o
//    LiveComponentsProvider lê via applyState(conn.state) ao adquirir).
// 2. onStateChange() só notifica MUDANÇAS FUTURAS — um listener registrado
//    depois do connect NÃO é chamado retroativamente. Por isso ler `.state`
//    no ato da aquisição é necessário (senão o novo Provider ficaria Offline).

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
    this.onclose?.({ code: 1000, reason: '' })
  })
  constructor(public url: string) {
    MockWebSocket.instances.push(this)
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
}

beforeEach(() => {
  MockWebSocket.instances = []
  ;(globalThis as any).WebSocket = MockWebSocket
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('LiveConnection — snapshot de estado (fix do Offline)', () => {
  it('.state reflete connected=true assim que o socket abre', () => {
    const conn = new LiveConnection({ url: 'ws://test', autoConnect: false })
    expect(conn.state.connected).toBe(false)

    conn.connect()
    MockWebSocket.instances[0].open()

    // É exatamente isto que o Provider lê ao adquirir do pool.
    expect(conn.state.connected).toBe(true)
    conn.destroy()
  })

  it('onStateChange NÃO chama o listener retroativamente (precisa ler .state)', () => {
    const conn = new LiveConnection({ url: 'ws://test', autoConnect: false })
    conn.connect()
    MockWebSocket.instances[0].open() // já conectado ANTES de assinar

    const listener = vi.fn()
    conn.onStateChange(listener)

    // Sem nenhuma mudança nova, o listener não foi chamado — provando que um
    // Provider que só assinasse (sem ler .state) ficaria preso em "Offline".
    expect(listener).not.toHaveBeenCalled()
    // Mas o estado atual está disponível via getter (o que o fix usa):
    expect(conn.state.connected).toBe(true)
    conn.destroy()
  })

  it('listener registrado ANTES do open É notificado na conexão', () => {
    const conn = new LiveConnection({ url: 'ws://test', autoConnect: false })
    const listener = vi.fn()
    conn.onStateChange(listener)

    conn.connect()
    MockWebSocket.instances[0].open()

    // Caso normal: quem assina antes recebe a transição para connected.
    expect(listener).toHaveBeenCalled()
    const lastState = listener.mock.calls[listener.mock.calls.length - 1][0]
    expect(lastState.connected).toBe(true)
    conn.destroy()
  })

  it('.state retorna uma cópia (mutação externa não afeta o estado interno)', () => {
    const conn = new LiveConnection({ url: 'ws://test', autoConnect: false })
    conn.connect()
    MockWebSocket.instances[0].open()

    const snap = conn.state
    snap.connected = false // mexer na cópia
    expect(conn.state.connected).toBe(true) // interno intacto
    conn.destroy()
  })
})
