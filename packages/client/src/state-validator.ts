// @fluxstack/live-client - State Validation Utilities

export interface StateValidation {
  checksum: string
  version: number
  timestamp: number
  source: 'client' | 'server' | 'mount'
}

export interface StateConflict {
  property: string
  clientValue: any
  serverValue: any
  timestamp: number
  resolved: boolean
}

export interface HybridState<T> {
  data: T
  validation: StateValidation
  status: 'synced' | 'pending' | 'conflict'
}

export class StateValidator {
  static generateChecksum(state: any): string {
    const json = JSON.stringify(state, Object.keys(state).sort())
    let hash = 0
    for (let i = 0; i < json.length; i++) {
      const char = json.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash
    }
    return Math.abs(hash).toString(16)
  }

  static createValidation(
    state: any,
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
    const clientKeys = Object.keys(clientState as any)
    const serverKeys = Object.keys(serverState as any)
    const allKeys = Array.from(new Set([...clientKeys, ...serverKeys]))

    for (const key of allKeys) {
      if (excludeFields.includes(key)) continue
      const clientValue = (clientState as any)?.[key]
      const serverValue = (serverState as any)?.[key]
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
    const merged = { ...clientState }

    for (const conflict of conflicts) {
      switch (strategy) {
        case 'client':
          break
        case 'server':
          (merged as any)[conflict.property] = conflict.serverValue
          break
        case 'smart':
          if (conflict.property === 'lastUpdated') {
            (merged as any)[conflict.property] = conflict.serverValue
          } else if (typeof conflict.serverValue === 'number' && typeof conflict.clientValue === 'number') {
            (merged as any)[conflict.property] = Math.max(conflict.serverValue, conflict.clientValue)
          } else {
            (merged as any)[conflict.property] = conflict.serverValue
          }
          break
      }
    }

    return merged
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
