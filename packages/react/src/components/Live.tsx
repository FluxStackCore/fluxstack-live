// @fluxstack/live-react - Live.use() API
//
// Usage:
//   import { Live } from '@fluxstack/live-react'
//   import { LiveForm } from '@server/live/LiveForm'
//
//   const form = Live.use(LiveForm)
//   const form = Live.use(LiveForm, { initialState: { name: 'John' } })

import type { ServerRoomProxy } from '@fluxstack/live'
import { useLiveComponent } from '../hooks/useLiveComponent'
import type { UseLiveComponentOptions, LiveProxyWithBroadcasts } from '../hooks/useLiveComponent'

// ===== Type Inference from Server Class =====

/** Construtor de qualquer aridade (`never[]` aceita qualquer lista de parâmetros). */
type Ctor<I = object> = new (...args: never[]) => I

type ExtractDefaultState<T> = T extends { defaultState: infer S }
  ? S extends object ? S : Record<string, unknown>
  : Record<string, unknown>

type ExtractState<T> = T extends Ctor<{ state: infer S }>
  ? S extends object ? S : Record<string, unknown>
  : ExtractDefaultState<T>

type ExtractPublicActionNames<T> = T extends { publicActions: readonly (infer A)[] }
  ? A extends string ? A : never
  : never

type ExtractActions<T> = T extends Ctor<infer Instance>
  ? T extends { publicActions: readonly string[] }
    ? {
        [K in keyof Instance as K extends ExtractPublicActionNames<T>
          ? Instance[K] extends (...args: never[]) => Promise<unknown> ? K : never
          : never
        ]: Instance[K]
      }
    : Record<string, never>
  : Record<string, never>

/** Extract TRoom from LiveComponent<TState, TPrivate, TRoom> via the $room getter */
type ExtractRoomState<T> = T extends Ctor<{ $room: { state: infer S } }>
  ? S : Record<string, unknown>

type ExtractRoomEvents<T> = T extends Ctor<{ $room: ServerRoomProxy<infer _S, infer E> }>
  ? E
  : Record<string, unknown>

// ===== Options =====

interface LiveUseOptions<TState> extends UseLiveComponentOptions<TState> {
  initialState?: Partial<TState>
}

/** O que `Live.use()` aceita: a classe do componente do servidor. */
type LiveComponentClassLike = Ctor & {
  defaultState?: object
  componentName: string
  publicActions?: readonly string[]
}

// ===== Hook =====

function useLive<
  T extends LiveComponentClassLike,
  TBroadcasts extends object = Record<string, unknown>
>(
  ComponentClass: T,
  options?: LiveUseOptions<ExtractState<T>>,
): LiveProxyWithBroadcasts<ExtractState<T>, ExtractActions<T>, TBroadcasts, ExtractRoomState<T>, ExtractRoomEvents<T>> {
  const componentName = ComponentClass.componentName
  const defaultState = ComponentClass.defaultState ?? {}
  const { initialState, ...restOptions } = options || {}
  // defaultState da classe + overrides: forma de ExtractState<T>.
  const mergedState = { ...defaultState, ...initialState } as ExtractState<T>

  return useLiveComponent<ExtractState<T>, ExtractActions<T>, TBroadcasts, ExtractRoomState<T>, ExtractRoomEvents<T>>(
    componentName,
    mergedState,
    restOptions,
  )
}

// ===== Export =====

import { LiveBoundary, LiveStatus } from './LiveBoundary'

export const Live = {
  use: useLive,
  /** <Live.Boundary live={x}> — mostra loading/erro/offline automático; children só quando pronto */
  Boundary: LiveBoundary,
  /** <Live.Status live={x} /> — pill Connected/Offline pronto */
  Status: LiveStatus,
}

export default Live
