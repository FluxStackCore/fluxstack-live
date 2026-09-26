// Pedidos em voo são rejeitados assim que a conexão cai (auditoria 2026-09-26).
// Antes esperavam o timeout inteiro, travando mount/rehydrate/action por 5-10s
// antes de tentar de novo na conexão nova.
import { describe, it, expect } from 'vitest'
import { LiveConnection } from '../connection'
import type { ClientTransport, ClientTransportHandlers } from '../transports'

/** Transporte controlável: abre na hora, nunca responde, fecha quando mandado. */
class ControlledTransport implements ClientTransport {
  readonly kind = 'fake'
  isOpen = false
  isConnecting = false
  handlers: ClientTransportHandlers | null = null
  open(h: ClientTransportHandlers) {
    this.handlers = h
    this.isOpen = true
    queueMicrotask(() => h.onOpen())
  }
  send() { /* engole: a resposta nunca vem */ }
  close(code = 1000, reason = '') { this.drop(code, reason) }
  drop(code = 1006, reason = 'network') {
    if (!this.isOpen) return
    this.isOpen = false
    const h = this.handlers
    this.handlers = null
    h?.onClose(code, reason)
  }
}

describe('pedidos pendentes quando a conexão cai', () => {
  it('rejeita na hora, sem esperar o timeout', async () => {
    let transport!: ControlledTransport
    const conn = new LiveConnection({
      transport: () => (transport = new ControlledTransport()),
      reconnectInterval: 60_000, // não reconectar durante o teste
      heartbeatInterval: 60_000,
    })
    await new Promise(r => setTimeout(r, 0))
    expect(conn.state.connected).toBe(true)

    const started = Date.now()
    const pending = conn.sendMessageAndWait({ type: 'CALL_ACTION', componentId: 'c1', action: 'x', payload: {} } as never, 10_000)
    transport.drop(1006, 'queda de rede')

    await expect(pending).rejects.toThrow(/Connection lost \(1006: queda de rede\)/)
    expect(Date.now() - started).toBeLessThan(1000)
    conn.destroy()
  })
})
