// @fluxstack/live - Component Type Utilities
//
// Type inference system for Live Components (similar to Eden Treaty).

import type { AnyLiveComponent } from './LiveComponent'

/** Qualquer função (checagem estrutural: `never[]` aceita qualquer lista de parâmetros). */
type AnyFunction = (...args: never[]) => unknown

// Utility types for better TypeScript experience
export type ComponentActions<T> = {
  [K in keyof T]: T[K] extends AnyFunction ? T[K] : never
}

export type ComponentProps<T extends AnyLiveComponent> = T extends { state: infer TState } ? TState : never

export type ActionParameters<T, K extends keyof T> = T[K] extends (...args: infer P) => unknown ? P : never

export type ActionReturnType<T, K extends keyof T> = T[K] extends (...args: never[]) => infer R ? R : never

/**
 * Extract all public action methods from a LiveComponent class
 * Excludes constructor, destroy, lifecycle methods, and inherited methods
 */
export type ExtractActions<T extends AnyLiveComponent> = {
  [K in keyof T as K extends string
    ? T[K] extends (payload: never) => Promise<unknown>
      ? K extends 'executeAction' | 'destroy' | 'getSerializableState' | 'setState'
        ? never
        : K
      : never
    : never]: T[K]
}

/**
 * Get all action names from a component
 */
export type ActionNames<T extends AnyLiveComponent> = keyof ExtractActions<T>

/**
 * Get the payload type for a specific action
 */
export type ActionPayload<
  T extends AnyLiveComponent,
  K extends ActionNames<T>
> = ExtractActions<T>[K] extends (payload: infer P) => unknown
  ? P
  : ExtractActions<T>[K] extends () => unknown
    ? undefined
    : never

/**
 * Get the return type for a specific action (unwrapped from Promise)
 */
export type ActionReturn<
  T extends AnyLiveComponent,
  K extends ActionNames<T>
> = ExtractActions<T>[K] extends (...args: never[]) => Promise<infer R>
  ? R
  : ExtractActions<T>[K] extends (...args: never[]) => infer R
    ? R
    : never

/**
 * Get the state type from a LiveComponent class
 */
// Inferência pelos membros (não por `LiveComponent<infer S>`): independe do TPrivate.
export type InferComponentState<T extends AnyLiveComponent> = T extends { state: infer S } ? S : never

/**
 * Get the private state type from a LiveComponent class
 */
export type InferPrivateState<T extends AnyLiveComponent> = T extends { readonly $private: infer P } ? P : never

/**
 * Type-safe call signature for a component
 */
export type TypedCall<T extends AnyLiveComponent> = <K extends ActionNames<T>>(
  action: K,
  ...args: ActionPayload<T, K> extends undefined
    ? []
    : [payload: ActionPayload<T, K>]
) => Promise<void>

/**
 * Type-safe callAndWait signature for a component
 */
export type TypedCallAndWait<T extends AnyLiveComponent> = <K extends ActionNames<T>>(
  action: K,
  ...args: ActionPayload<T, K> extends undefined
    ? [payload?: undefined, timeout?: number]
    : [payload: ActionPayload<T, K>, timeout?: number]
) => Promise<ActionReturn<T, K>>

/**
 * Type-safe setValue signature for a component
 */
export type TypedSetValue<T extends AnyLiveComponent> = <K extends keyof InferComponentState<T>>(
  key: K,
  value: InferComponentState<T>[K]
) => Promise<void>

/**
 * Return type for useTypedLiveComponent hook
 */
export interface UseTypedLiveComponentReturn<T extends AnyLiveComponent> {
  state: InferComponentState<T>
  loading: boolean
  error: string | null
  connected: boolean
  componentId: string | null
  status: 'synced' | 'disconnected' | 'connecting' | 'reconnecting' | 'loading' | 'mounting' | 'error'
  call: TypedCall<T>
  callAndWait: TypedCallAndWait<T>
  setValue: TypedSetValue<T>
  mount: () => Promise<void>
  unmount: () => Promise<void>
  useControlledField: <K extends keyof InferComponentState<T>>(field: K, action?: string) => {
    value: InferComponentState<T>[K]
    setValue: (value: InferComponentState<T>[K]) => void
    commit: (value?: InferComponentState<T>[K]) => Promise<void>
    isDirty: boolean
  }
}
