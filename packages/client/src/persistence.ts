// @fluxstack/live-client - State Persistence
//
// Utilities for persisting and recovering component state via localStorage.

import { isRecord, isSignedState } from './protocol'
import type { SignedState } from '@fluxstack/live'

const STORAGE_KEY_PREFIX = 'fluxstack_component_'
const STATE_MAX_AGE = 24 * 60 * 60 * 1000 // 24 hours
/** Idade máxima de um signedState persistido para tentar re-hidratar (mesma regra do hook React). */
export const REHYDRATE_MAX_AGE = 60 * 60 * 1000 // 1 hora

/** Sem `localStorage` (SSR, Node, workers): persistência vira no-op silencioso. */
const hasStorage = (): boolean => typeof localStorage !== 'undefined'

export interface PersistedState {
  componentName: string
  /** Estado assinado pelo servidor (`SignedState`); validar com `isSignedState` antes de reenviar. */
  signedState: unknown
  room?: string
  userId?: string
  lastUpdate: number
}

export function persistState(
  enabled: boolean,
  name: string,
  signedState: unknown,
  room?: string,
  userId?: string,
): void {
  if (!enabled || !hasStorage()) return
  try {
    localStorage.setItem(`${STORAGE_KEY_PREFIX}${name}`, JSON.stringify({
      componentName: name, signedState, room, userId, lastUpdate: Date.now(),
    }))
  } catch (e) {
    if (typeof console !== 'undefined') {
      console.warn(`[fluxstack] Failed to persist state for '${name}':`, e instanceof Error ? e.message : e)
    }
  }
}

export function getPersistedState(enabled: boolean, name: string): PersistedState | null {
  if (!enabled || !hasStorage()) return null
  try {
    const stored = localStorage.getItem(`${STORAGE_KEY_PREFIX}${name}`)
    if (!stored) return null
    const parsed: unknown = JSON.parse(stored)
    // localStorage é entrada não confiável: confere a forma antes de usar.
    if (!isRecord(parsed) || typeof parsed.lastUpdate !== 'number') {
      localStorage.removeItem(`${STORAGE_KEY_PREFIX}${name}`)
      return null
    }
    if (Date.now() - parsed.lastUpdate > STATE_MAX_AGE) {
      localStorage.removeItem(`${STORAGE_KEY_PREFIX}${name}`)
      return null
    }
    return {
      componentName: typeof parsed.componentName === 'string' ? parsed.componentName : name,
      signedState: parsed.signedState,
      room: typeof parsed.room === 'string' ? parsed.room : undefined,
      userId: typeof parsed.userId === 'string' ? parsed.userId : undefined,
      lastUpdate: parsed.lastUpdate,
    }
  } catch { return null }
}

export function clearPersistedState(enabled: boolean, name: string): void {
  if (!enabled || !hasStorage()) return
  try { localStorage.removeItem(`${STORAGE_KEY_PREFIX}${name}`) } catch {}
}

/**
 * signedState persistido pronto para `COMPONENT_REHYDRATE`, ou `null`.
 * Descarta (e apaga) o que estiver velho demais (`maxAge`, padrão 1 h) ou com
 * forma inválida — a mesma regra que o hook React aplica antes de re-hidratar.
 */
export function getRehydratableState(
  enabled: boolean,
  name: string,
  maxAge: number = REHYDRATE_MAX_AGE,
): { signedState: SignedState; room?: string; userId?: string } | null {
  const persisted = getPersistedState(enabled, name)
  if (!persisted) return null
  if (Date.now() - persisted.lastUpdate > maxAge || !isSignedState(persisted.signedState)) {
    clearPersistedState(enabled, name)
    return null
  }
  return { signedState: persisted.signedState, room: persisted.room, userId: persisted.userId }
}
