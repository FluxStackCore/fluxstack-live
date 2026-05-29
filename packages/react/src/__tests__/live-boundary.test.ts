// Testes da lógica de decisão do <Live.Boundary> (resolveBoundarySlot).
// Função pura — não precisa renderizar React (o package não tem DOM infra),
// mas trava o contrato: dado o $status/$connected, qual slot é mostrado.

import { describe, it, expect } from 'vitest'
import { resolveBoundarySlot, type BoundarySlot } from '../components/LiveBoundary'

type Status = 'synced' | 'disconnected' | 'connecting' | 'reconnecting' | 'loading' | 'mounting' | 'error'

function live(status: Status, connected: boolean) {
  return { $status: status, $connected: connected }
}

describe('resolveBoundarySlot', () => {
  it('error tem precedência sobre tudo', () => {
    expect(resolveBoundarySlot(live('error', true))).toBe('error')
    expect(resolveBoundarySlot(live('error', false))).toBe('error')
  })

  it('estados de transição mostram loading', () => {
    const loadingStates: Status[] = ['connecting', 'mounting', 'loading', 'reconnecting']
    for (const s of loadingStates) {
      expect(resolveBoundarySlot(live(s, false))).toBe('loading')
      expect(resolveBoundarySlot(live(s, true))).toBe('loading')
    }
  })

  it('desconectado (sem transição/erro) mostra offline', () => {
    expect(resolveBoundarySlot(live('disconnected', false))).toBe('offline')
  })

  it('synced e conectado mostra os children', () => {
    expect(resolveBoundarySlot(live('synced', true))).toBe('children')
  })

  it('showWhileOffline força children mesmo desconectado', () => {
    expect(resolveBoundarySlot(live('disconnected', false), true)).toBe('children')
  })

  it('showWhileOffline NÃO suprime erro nem loading', () => {
    expect(resolveBoundarySlot(live('error', false), true)).toBe('error')
    expect(resolveBoundarySlot(live('connecting', false), true)).toBe('loading')
  })

  it('cobre todos os 7 status sem cair em estado inválido', () => {
    const all: Status[] = ['synced', 'disconnected', 'connecting', 'reconnecting', 'loading', 'mounting', 'error']
    const valid: BoundarySlot[] = ['error', 'loading', 'offline', 'children']
    for (const s of all) {
      expect(valid).toContain(resolveBoundarySlot(live(s, s === 'synced')))
    }
  })
})
