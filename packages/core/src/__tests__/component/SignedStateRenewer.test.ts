import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SignedStateRenewer } from '../../component/SignedStateRenewer'

describe('SignedStateRenewer (throttle leading + trailing)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const make = (intervalMs = 1000) => {
    const renew = vi.fn<(id: string) => void>()
    const r = new SignedStateRenewer({ intervalMs, renew, now: () => Date.now() })
    return { r, renew }
  }

  it('primeiro delta depois de ociosidade assina no próximo tick (lote síncrono inteiro)', () => {
    const { r, renew } = make()
    r.notifyDelta('a'); r.notifyDelta('a'); r.notifyDelta('a')
    expect(renew).not.toHaveBeenCalled() // nunca no caminho síncrono do delta
    vi.advanceTimersByTime(0)
    expect(renew).toHaveBeenCalledTimes(1)
    expect(renew).toHaveBeenCalledWith('a')
  })

  it('rajada contínua: 1 assinatura por janela, trailing no fim', () => {
    const { r, renew } = make(1000)
    // 100 deltas espalhados por 2.5s
    for (let t = 0; t < 2500; t += 25) {
      r.notifyDelta('a')
      vi.advanceTimersByTime(25)
    }
    vi.advanceTimersByTime(1000)
    // leading (t=0) + t=1000 + t=2000 + trailing (t=3000)
    expect(renew.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(renew.mock.calls.length).toBeLessThanOrEqual(4)
  })

  it('markSigned (mount/rehydrate) abre a janela: delta logo depois espera o fim dela', () => {
    const { r, renew } = make(1000)
    r.markSigned('a')
    vi.advanceTimersByTime(100)
    r.notifyDelta('a')
    vi.advanceTimersByTime(800)
    expect(renew).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(renew).toHaveBeenCalledTimes(1)
  })

  it('sem delta não assina', () => {
    const { r, renew } = make(100)
    r.markSigned('a')
    vi.advanceTimersByTime(10_000)
    expect(renew).not.toHaveBeenCalled()
  })

  it('componentes independentes', () => {
    const { r, renew } = make(1000)
    r.notifyDelta('a'); r.notifyDelta('b')
    vi.advanceTimersByTime(0)
    expect(renew.mock.calls.map(c => c[0]).sort()).toEqual(['a', 'b'])
  })

  it('forget cancela a renovação pendente; stop cancela todas', () => {
    const { r, renew } = make(1000)
    r.markSigned('a'); r.notifyDelta('a')
    r.markSigned('b'); r.notifyDelta('b')
    expect(r.pendingCount).toBe(2)
    r.forget('a')
    r.stop()
    vi.advanceTimersByTime(5000)
    expect(renew).not.toHaveBeenCalled()
    expect(r.pendingCount).toBe(0)
  })

  it('intervalMs <= 0 desliga', () => {
    const { r, renew } = make(0)
    expect(r.enabled).toBe(false)
    r.notifyDelta('a')
    vi.advanceTimersByTime(5000)
    expect(renew).not.toHaveBeenCalled()
  })

  it('erro no renew não derruba o throttler', () => {
    const renew = vi.fn(() => { throw new Error('boom') })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = new SignedStateRenewer({ intervalMs: 100, renew })
    r.notifyDelta('a')
    vi.advanceTimersByTime(0)
    r.notifyDelta('a')
    vi.advanceTimersByTime(100)
    expect(renew).toHaveBeenCalledTimes(2)
    err.mockRestore()
  })
})
