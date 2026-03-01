// @fluxstack/live-client - State Persistence
//
// Utilities for persisting and recovering component state via localStorage.

const STORAGE_KEY_PREFIX = 'fluxstack_component_'
const STATE_MAX_AGE = 24 * 60 * 60 * 1000 // 24 hours

export interface PersistedState {
  componentName: string
  signedState: any
  room?: string
  userId?: string
  lastUpdate: number
}

export function persistState(
  enabled: boolean,
  name: string,
  signedState: any,
  room?: string,
  userId?: string,
): void {
  if (!enabled) return
  try {
    localStorage.setItem(`${STORAGE_KEY_PREFIX}${name}`, JSON.stringify({
      componentName: name, signedState, room, userId, lastUpdate: Date.now(),
    }))
  } catch {}
}

export function getPersistedState(enabled: boolean, name: string): PersistedState | null {
  if (!enabled) return null
  try {
    const stored = localStorage.getItem(`${STORAGE_KEY_PREFIX}${name}`)
    if (!stored) return null
    const state: PersistedState = JSON.parse(stored)
    if (Date.now() - state.lastUpdate > STATE_MAX_AGE) {
      localStorage.removeItem(`${STORAGE_KEY_PREFIX}${name}`)
      return null
    }
    return state
  } catch { return null }
}

export function clearPersistedState(enabled: boolean, name: string): void {
  if (!enabled) return
  try { localStorage.removeItem(`${STORAGE_KEY_PREFIX}${name}`) } catch {}
}
