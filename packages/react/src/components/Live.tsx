// @fluxstack/live-react - Live.use() API
//
// Usage:
//   import { Live } from '@fluxstack/live-react'
//   import { LiveForm } from '@server/live/LiveForm'
//
//   const form = Live.use(LiveForm)
//   const form = Live.use(LiveForm, { initialState: { name: 'John' } })

import { useLiveComponent } from '../hooks/useLiveComponent'
import type { UseLiveComponentOptions, LiveProxyWithBroadcasts } from '../hooks/useLiveComponent'

// ===== Type Inference from Server Class =====

type ExtractDefaultState<T> = T extends { defaultState: infer S }
  ? S extends Record<string, any> ? S : Record<string, any>
  : Record<string, any>

type ExtractState<T> = T extends { new(...args: any[]): { state: infer S } }
  ? S extends Record<string, any> ? S : Record<string, any>
  : ExtractDefaultState<T>

type ExtractPublicActionNames<T> = T extends { publicActions: readonly (infer A)[] }
  ? A extends string ? A : never
  : never

type ExtractActions<T> = T extends { new(...args: any[]): infer Instance }
  ? T extends { publicActions: readonly string[] }
    ? {
        [K in keyof Instance as K extends ExtractPublicActionNames<T>
          ? Instance[K] extends (...args: any[]) => Promise<any> ? K : never
          : never
        ]: Instance[K]
      }
    : Record<string, never>
  : Record<string, never>

// ===== Options =====

interface LiveUseOptions<TState> extends UseLiveComponentOptions {
  initialState?: Partial<TState>
}

// ===== Hook =====

function useLive<
  T extends { new(...args: any[]): any; defaultState?: Record<string, any>; componentName: string; publicActions?: readonly string[] },
  TBroadcasts extends Record<string, any> = Record<string, any>
>(
  ComponentClass: T,
  options?: LiveUseOptions<ExtractState<T>>,
): LiveProxyWithBroadcasts<ExtractState<T>, ExtractActions<T>, TBroadcasts> {
  const componentName = ComponentClass.componentName
  const defaultState = (ComponentClass as any).defaultState || {}
  const { initialState, ...restOptions } = options || {}
  const mergedState = { ...defaultState, ...initialState } as ExtractState<T>

  return useLiveComponent<ExtractState<T>, ExtractActions<T>, TBroadcasts>(
    componentName,
    mergedState,
    restOptions,
  )
}

// ===== Export =====

export const Live = {
  use: useLive,
}

export default Live
