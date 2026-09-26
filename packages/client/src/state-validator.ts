// @fluxstack/live-client - State Validation Utilities

import { isRecord } from './protocol'

export interface StateValidation {
  checksum: string
  version: number
  timestamp: number
  source: 'client' | 'server' | 'mount'
}

export interface StateConflict {
  property: string
  clientValue: unknown
  serverValue: unknown
  timestamp: number
  resolved: boolean
}

export interface HybridState<T> {
  data: T
  validation: StateValidation
  status: 'synced' | 'pending' | 'conflict'
}

export class StateValidator {
  static generateChecksum(state: unknown): string {
    const keys = isRecord(state) ? Object.keys(state).sort() : undefined
    const json = JSON.stringify(state, keys) ?? ''
    let hash = 0
    for (let i = 0; i < json.length; i++) {
      const char = json.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash
    }
    return Math.abs(hash).toString(16)
  }

  static createValidation(
    state: unknown,
    source: 'client' | 'server' | 'mount' = 'client',
  ): StateValidation {
    return {
      checksum: this.generateChecksum(state),
      version: Date.now(),
      timestamp: Date.now(),
      source,
    }
  }

  static detectConflicts<T>(
    clientState: T,
    serverState: T,
    excludeFields: string[] = ['lastUpdated', 'version'],
  ): StateConflict[] {
    const conflicts: StateConflict[] = []
    // Guard against null/undefined — Object.keys throws on those, and the
    // hybrid-state path can hand us either side as null (mount-before-sync).
    const client: Record<string, unknown> = isRecord(clientState) ? clientState : {}
    const server: Record<string, unknown> = isRecord(serverState) ? serverState : {}
    const allKeys = Array.from(new Set([...Object.keys(client), ...Object.keys(server)]))

    for (const key of allKeys) {
      if (excludeFields.includes(key)) continue
      const clientValue = client[key]
      const serverValue = server[key]
      if (JSON.stringify(clientValue) !== JSON.stringify(serverValue)) {
        conflicts.push({
          property: key,
          clientValue,
          serverValue,
          timestamp: Date.now(),
          resolved: false,
        })
      }
    }

    return conflicts
  }

  static mergeStates<T>(
    clientState: T,
    serverState: T,
    conflicts: StateConflict[],
    strategy: 'client' | 'server' | 'smart' = 'smart',
  ): T {
    const merged: Record<string, unknown> = isRecord(clientState) ? { ...clientState } : {}

    for (const conflict of conflicts) {
      switch (strategy) {
        case 'client':
          break
        case 'server':
          merged[conflict.property] = conflict.serverValue
          break
        case 'smart':
          if (conflict.property === 'lastUpdated') {
            merged[conflict.property] = conflict.serverValue
          } else if (typeof conflict.serverValue === 'number' && typeof conflict.clientValue === 'number') {
            merged[conflict.property] = Math.max(conflict.serverValue, conflict.clientValue)
          } else {
            merged[conflict.property] = conflict.serverValue
          }
          break
      }
    }

    // Mesmas chaves de T (conflitos vêm das chaves dos dois estados).
    return merged as T
  }

  static validateState<T>(hybridState: HybridState<T>): boolean {
    const currentChecksum = this.generateChecksum(hybridState.data)
    return currentChecksum === hybridState.validation.checksum
  }

  static updateValidation<T>(
    hybridState: HybridState<T>,
    source: 'client' | 'server' | 'mount' = 'client',
  ): HybridState<T> {
    return {
      ...hybridState,
      validation: this.createValidation(hybridState.data, source),
      status: 'synced',
    }
  }
}
