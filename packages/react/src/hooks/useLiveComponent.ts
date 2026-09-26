'use client'
// @fluxstack/live-react - useLiveComponent Hook
//
// Proxy-based state access for Live Components.
// Access server state as if they were local variables (Livewire-style).
//
// Usage:
//   const clock = useLiveComponent('LiveClock', { currentTime: '', format: '24h' })
//   console.log(clock.currentTime)  // "14:30:25"
//   clock.format = '12h'            // auto-syncs to server
//   await clock.setTimeFormat({ format: '24h' })  // call action

import { useRef, useMemo, useState, useEffect, useCallback } from 'react'
import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import { useLiveComponents } from '../LiveComponentsProvider'
import {
  RoomManager,
  persistState,
  getPersistedState,
  clearPersistedState,
  clientMessages,
  isSignedState,
  readBroadcast,
  readErrorMessage,
  readMountResult,
  readRehydrateResult,
  readStateDelta,
  readStateRehydrated,
  readStateSignature,
  readStateUpdate,
  toRecord,
} from '@fluxstack/live-client'
import type { RoomProxy, RoomServerMessage } from '@fluxstack/live-client'
import type { WebSocketResponse } from '@fluxstack/live'
import { generateId } from '@fluxstack/live-client'
import { computeStatus, notReadyError as makeNotReadyError } from './readiness'

const errorMessage = (err: unknown): string => err instanceof Error ? err.message : String(err)

// ===== Deep Merge (always-on, retrocompatible) =====

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    && Object.getPrototypeOf(v) === Object.prototype
}

/**
 * Apply a STATE_DELTA coming from the server.
 *
 * Semantics (matches core's `deepAssign`, fixes #6):
 * - Top-level (depth === 0): `null` is a real value — `result[key] = null`.
 *   Top-level state keys are part of the component schema and are not
 *   dynamically added/removed, so there is no ambiguity with a deletion
 *   signal.
 * - Nested (depth > 0): `null` is the deletion sentinel from the core's
 *   `computeDeepDiff` — remove the key. This is what the
 *   `Record<string, T>` scenario from issue #1/#3 relies on.
 * - `undefined` is a no-op (skipped) — these values don't cross the wire.
 */
function deepMerge<T extends object>(target: T, source: object, seen?: Set<object>): T {
  // Deltas do servidor trazem chaves do próprio estado: o resultado mantém o tipo do alvo.
  return deepMergeImpl(toRecord(target), toRecord(source), 0, seen) as T
}

function deepMergeImpl(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  depth: number,
  seen?: Set<object>,
): Record<string, unknown> {
  if (!seen) seen = new Set()
  if (seen.has(source)) return target
  seen.add(source)

  const result: Record<string, unknown> = { ...target }
  for (const key of Object.keys(source)) {
    const newVal = source[key]
    if (newVal === undefined) continue
    if (newVal === null) {
      if (depth === 0) {
        result[key] = null
      } else {
        delete result[key]
      }
      continue
    }
    const oldVal = result[key]
    if (isPlainObject(oldVal) && isPlainObject(newVal)) {
      result[key] = deepMergeImpl(oldVal, newVal, depth + 1, seen)
    } else {
      result[key] = newVal
    }
  }
  return result
}

// ===== Types =====

export interface FieldOptions {
  syncOn?: 'change' | 'blur' | 'manual'
  debounce?: number
  /** Transforma o valor digitado antes de sincronizar (sintaxe de método: aceita `(v: string) => ...`). */
  transform?(value: unknown): unknown
}

/** Valor aceito pelo `value` de `<input>`, `<textarea>` e `<select>`. */
export type FieldInputValue = string | number | readonly string[]

/** Evento mínimo lido por `$field().onChange` (compatível com `ChangeEvent` do React). */
export interface FieldChangeEvent {
  target: { value: string; type?: string; checked?: boolean }
}

export interface FieldBinding {
  value: FieldInputValue
  onChange: (e: FieldChangeEvent) => void
  onBlur: () => void
  name: string
}

/** Evento de broadcast entregue a `$onBroadcast`. */
export interface LiveBroadcastEvent {
  type: string
  data: unknown
}

/** Estado padrão de sala quando o componente não declara um. */
type DefaultRoomState = Record<string, unknown>
/** Mapa de eventos padrão (nome → payload). */
type DefaultEventMap = Record<string, unknown>

export interface LiveComponentProxy<
  TState extends object,
  TRoomState = DefaultRoomState,
  TRoomEvents extends object = DefaultEventMap
> {
  readonly $state: TState
  readonly $connected: boolean
  /**
   * `true` when the component has finished its server-side mount handshake
   * and is safe to call actions on (equivalent to `$status === 'synced'`).
   *
   * Prefer `$ready` over `$connected` as an action gate: `$connected` only
   * reflects the underlying WebSocket and may be `true` during the brief
   * window before the component is mounted on the server — actions fired
   * in that window will reject with "Component not yet mounted" (#35).
   */
  readonly $ready: boolean
  readonly $loading: boolean
  readonly $error: string | null
  readonly $status: 'synced' | 'disconnected' | 'connecting' | 'reconnecting' | 'loading' | 'mounting' | 'error'
  readonly $componentId: string | null
  readonly $dirty: boolean
  readonly $authenticated: boolean
  readonly $auth: { authenticated: boolean; session: Record<string, unknown> | null }

  $call: (action: string, payload?: unknown) => Promise<void>
  /**
   * Chama a action e devolve a RESPOSTA do servidor (`WebSocketResponse`, com
   * `success`/`result`/`error`) — não só o `result`. Passe `R` para estreitar.
   */
  $callAndWait: <R = WebSocketResponse>(action: string, payload?: unknown, timeout?: number) => Promise<R>
  $fire: (action: string, payload?: unknown) => void
  $mount: () => Promise<void>
  $unmount: () => Promise<void>
  $refresh: () => Promise<void>
  $set: <K extends keyof TState>(key: K, value: TState[K]) => Promise<void>
  $field: <K extends keyof TState>(key: K, options?: FieldOptions) => FieldBinding
  $sync: () => Promise<void>
  $onBroadcast: (handler: (event: LiveBroadcastEvent) => void) => void
  $updateLocal: (updates: Partial<TState>) => void
  readonly $room: RoomProxy<TRoomState, TRoomEvents>
  readonly $rooms: string[]
}

type BroadcastEvent<T extends object> = {
  [K in keyof T]: { type: K; data: T[K] }
}[keyof T]

export interface LiveComponentProxyWithBroadcasts<
  TState extends object,
  TBroadcasts extends object = DefaultEventMap,
  TRoomState = DefaultRoomState,
  TRoomEvents extends object = DefaultEventMap
> extends Omit<LiveComponentProxy<TState, TRoomState, TRoomEvents>, '$onBroadcast'> {
  $onBroadcast: <T extends TBroadcasts = TBroadcasts>(
    handler: (event: BroadcastEvent<T>) => void
  ) => void
}

export type LiveProxy<
  TState extends object,
  TActions = {},
  TRoomState = DefaultRoomState,
  TRoomEvents extends object = DefaultEventMap
> = TState & LiveComponentProxy<TState, TRoomState, TRoomEvents> & TActions

export type LiveProxyWithBroadcasts<
  TState extends object,
  TActions = {},
  TBroadcasts extends object = DefaultEventMap,
  TRoomState = DefaultRoomState,
  TRoomEvents extends object = DefaultEventMap
> = TState & LiveComponentProxyWithBroadcasts<TState, TBroadcasts, TRoomState, TRoomEvents> & TActions

export interface HybridComponentOptions<TState = Record<string, unknown>> {
  room?: string
  userId?: string
  autoMount?: boolean
  fallbackToLocal?: boolean
  debug?: boolean
  onConnect?: () => void
  onMount?: () => void
  onDisconnect?: () => void
  onRehydrate?: () => void
  onError?: (error: string) => void
  /** Sintaxe de método: aceita callbacks com o estado já tipado. */
  onStateChange?(state: TState, prevState: TState): void
}

export interface UseLiveComponentOptions<TState = Record<string, unknown>> extends HybridComponentOptions<TState> {
  debounce?: number
  optimistic?: boolean
  syncMode?: 'immediate' | 'debounced' | 'manual'
  persistState?: boolean
  debugLabel?: string
  /** Binary decoder for high-frequency binary state deltas. When set, the component will accept binary WebSocket frames and decode them into state deltas. */
  binaryDecoder?: (buffer: Uint8Array) => Partial<TState> | Record<string, unknown>
}

// ===== Reserved Props =====

const RESERVED_PROPS = new Set([
  '$state', '$connected', '$ready', '$loading', '$error', '$status', '$componentId', '$dirty', '$authenticated', '$auth',
  '$call', '$callAndWait', '$fire', '$mount', '$unmount', '$refresh', '$set', '$onBroadcast', '$updateLocal',
  '$room', '$rooms', '$field', '$sync',
  'then', 'toJSON', 'valueOf', 'toString',
  Symbol.toStringTag, Symbol.iterator,
])

/** @internal Exposed for tests. Subject to change without notice. */
export const _RESERVED_PROPS = RESERVED_PROPS

// ===== Zustand Store =====

interface Store<T> {
  state: T
  status: 'synced' | 'disconnected'
  updateState: (newState: T) => void
}

function createStore<T>(initialState: T) {
  return create<Store<T>>()(
    subscribeWithSelector((set) => ({
      state: initialState,
      status: 'disconnected',
      updateState: (newState: T) => set({ state: newState, status: 'synced' }),
    }))
  )
}

// ===== Main Hook =====

export function useLiveComponent<
  TState extends object,
  TActions = {},
  TBroadcasts extends object = DefaultEventMap,
  TRoomState = DefaultRoomState,
  TRoomEvents extends object = DefaultEventMap
>(
  componentName: string,
  initialState: TState,
  options: UseLiveComponentOptions<TState> = {},
): LiveProxyWithBroadcasts<TState, TActions, TBroadcasts, TRoomState, TRoomEvents> {
  const {
    debounce = 150,
    optimistic = true,
    syncMode = 'debounced',
    persistState: persistEnabled = true,
    fallbackToLocal = true,
    room,
    userId,
    autoMount = true,
    debug = false,
    onConnect,
    onMount,
    onDisconnect,
    onRehydrate,
    onError,
    onStateChange,
    binaryDecoder,
  } = options

  const {
    connected,
    authenticated: wsAuthenticated,
    $auth: wsAuth,
    sendMessage,
    sendMessageAndWait,
    registerComponent,
    registerBinaryHandler,
    registerRoomBinaryHandler,
    unregisterComponent,
  } = useLiveComponents()

  // Refs
  const instanceId = useRef(generateId())
  const storeRef = useRef<ReturnType<typeof createStore<TState>> | null>(null)
  if (!storeRef.current) storeRef.current = createStore(initialState)
  const store = storeRef.current

  const pendingChanges = useRef<Map<keyof TState, { value: unknown; synced: boolean }>>(new Map())
  const debounceTimers = useRef<Map<keyof TState, ReturnType<typeof setTimeout>>>(new Map())
  const localFieldValues = useRef<Map<keyof TState, unknown>>(new Map())
  const fieldOptionsRef = useRef<Map<keyof TState, FieldOptions>>(new Map())
  const [localVersion, setLocalVersion] = useState(0)
  const mountedRef = useRef(false)
  const mountingRef = useRef(false)
  const rehydratingRef = useRef(false)
  const lastComponentIdRef = useRef<string | null>(null)
  const broadcastHandlerRef = useRef<((event: LiveBroadcastEvent) => void) | null>(null)
  const roomMessageHandlers = useRef<Set<(msg: RoomServerMessage) => void>>(new Set())
  const roomManagerRef = useRef<RoomManager<TRoomState, TRoomEvents> | null>(null)
  const mountFnRef = useRef<(() => Promise<void>) | null>(null)
  // Handler refs — keep registration effect stable across state updates
  const handlersRef = useRef({ onStateChange, onRehydrate, onError })
  handlersRef.current = { onStateChange, onRehydrate, onError }
  const persistMetaRef = useRef({ persistEnabled, componentName, room, userId })
  persistMetaRef.current = { persistEnabled, componentName, room, userId }
  const binaryDecoderRef = useRef(binaryDecoder)
  binaryDecoderRef.current = binaryDecoder

  // State
  const stateData = store((s) => s.state)
  const updateState = store((s) => s.updateState)
  const [componentId, setComponentId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rehydrating, setRehydrating] = useState(false)
  const [mountFailed, setMountFailed] = useState(false)
  const [authDenied, setAuthDenied] = useState(false)

  const log = useCallback((msg: string, data?: unknown) => {
    if (debug) console.log(`[${componentName}] ${msg}`, data || '')
  }, [debug, componentName])

  // ===== Set Property =====
  const setProperty = useCallback(async <K extends keyof TState>(key: K, value: unknown) => {
    const timer = debounceTimers.current.get(key)
    if (timer) clearTimeout(timer)

    pendingChanges.current.set(key, { value, synced: false })

    const doSync = async () => {
      try {
        const id = componentId || lastComponentIdRef.current
        if (!id || !connected) return

        await sendMessageAndWait(clientMessages.callAction(id, 'setValue', { key, value }), 5000)

        const pending = pendingChanges.current.get(key)
        if (pending) pending.synced = true
      } catch (err) {
        pendingChanges.current.delete(key)
        setError(errorMessage(err))
      }
    }

    if (syncMode === 'immediate') {
      await doSync()
    } else if (syncMode === 'debounced') {
      debounceTimers.current.set(key, setTimeout(doSync, debounce))
    }
  }, [componentId, connected, sendMessageAndWait, debounce, syncMode])

  // ===== Mount =====
  const mount = useCallback(async () => {
    if (!connected || mountedRef.current || mountingRef.current || rehydratingRef.current || mountFailed) return

    mountingRef.current = true
    setLoading(true)
    setError(null)

    try {
      const response = await sendMessageAndWait(
        clientMessages.mount(instanceId.current, {
          component: componentName,
          props: toRecord(initialState),
          room,
          userId,
          debugLabel: options.debugLabel,
        }),
        5000,
      )

      const result = response?.success ? readMountResult(response) : null
      if (result) {
        const newId = result.componentId
        setComponentId(newId)
        lastComponentIdRef.current = newId
        mountedRef.current = true

        if (result.signedState) {
          persistState(persistEnabled, componentName, result.signedState, room, userId)
        }
        if (result.initialState) {
          // Estado inicial vindo do servidor: chaves do estado deste componente.
          updateState(result.initialState as TState)
        }

        log('Mounted', newId)
        setTimeout(() => onMount?.(), 0)
      } else {
        throw new Error(response?.error || 'Mount failed')
      }
    } catch (err) {
      const message = errorMessage(err)
      setError(message)
      if (message.includes('AUTH_DENIED')) setAuthDenied(true)
      setMountFailed(true)
      onError?.(message)
      if (!fallbackToLocal) throw err
    } finally {
      setLoading(false)
      mountingRef.current = false
    }
  }, [connected, componentName, initialState, room, userId, sendMessageAndWait, updateState, log, onMount, onError, fallbackToLocal, mountFailed])

  mountFnRef.current = mount

  // ===== Unmount =====
  const unmount = useCallback(async () => {
    if (!componentId || !connected) return
    try {
      await sendMessage(clientMessages.unmount(componentId))
      setComponentId(null)
      mountedRef.current = false
    } catch {}
  }, [componentId, connected, sendMessage])

  // ===== Rehydrate =====
  const rehydrate = useCallback(async () => {
    if (!connected || rehydratingRef.current || mountingRef.current || mountedRef.current) return false

    const persisted = getPersistedState(persistEnabled, componentName)
    if (!persisted) return false

    if (Date.now() - persisted.lastUpdate > 60 * 60 * 1000 || !isSignedState(persisted.signedState)) {
      clearPersistedState(persistEnabled, componentName)
      return false
    }

    rehydratingRef.current = true
    setRehydrating(true)
    try {
      // O servidor lê `payload.component` (antes ia `componentName` → sempre recusado).
      const response = await sendMessageAndWait(
        clientMessages.rehydrate(lastComponentIdRef.current || instanceId.current, {
          component: componentName,
          signedState: persisted.signedState,
          room: persisted.room,
          userId: persisted.userId,
        }),
        2000,
      )

      const result = response?.success ? readRehydrateResult(response) : null
      if (result) {
        // O estado re-hidratado chega em STATE_REHYDRATED (entregue ao registrar o novo id).
        setComponentId(result.newComponentId)
        lastComponentIdRef.current = result.newComponentId
        mountedRef.current = true
        setTimeout(() => onRehydrate?.(), 0)
        return true
      }
      clearPersistedState(persistEnabled, componentName)
      return false
    } catch {
      clearPersistedState(persistEnabled, componentName)
      return false
    } finally {
      rehydratingRef.current = false
      setRehydrating(false)
    }
  }, [connected, componentName, persistEnabled, sendMessageAndWait, onRehydrate])

  // Build a precise error explaining WHY an action can't run right now.
  // Differentiates "WebSocket down" from "component not mounted yet" (#35).
  const notReadyError = (action: string): Error =>
    makeNotReadyError(action, componentName, { connected, rehydrating, loading, error, componentId })

  // ===== Call Action =====
  const call = useCallback(async (action: string, payload?: unknown) => {
    const id = componentId || lastComponentIdRef.current
    if (!id || !connected) throw notReadyError(action)

    const response = await sendMessageAndWait(clientMessages.callAction(id, action, payload), 5000)

    if (!response.success) throw new Error(response.error || 'Action failed')
  }, [componentId, connected, sendMessageAndWait])

  const callAndWait = useCallback(async <R = WebSocketResponse>(action: string, payload?: unknown, timeout = 10000): Promise<R> => {
    const id = componentId || lastComponentIdRef.current
    if (!id || !connected) throw notReadyError(action)

    const response = await sendMessageAndWait(clientMessages.callAction(id, action, payload), timeout)

    // Contrato histórico: devolve a resposta inteira; o chamador escolhe R.
    return response as R
  }, [componentId, connected, sendMessageAndWait])

  // ===== Fire (fire-and-forget, no response) =====
  const fire = useCallback((action: string, payload?: unknown) => {
    const id = componentId || lastComponentIdRef.current
    if (!id || !connected) return

    sendMessage(clientMessages.callAction(id, action, payload, false)).catch(() => {})
  }, [componentId, connected, sendMessage])

  // ===== Refresh =====
  const refresh = useCallback(async () => {
    for (const [key, change] of pendingChanges.current) {
      if (!change.synced) await setProperty(key, change.value)
    }
  }, [setProperty])

  // ===== Sync =====
  const sync = useCallback(async () => {
    const promises: Promise<void>[] = []
    for (const [key, value] of localFieldValues.current) {
      if (value !== stateData[key]) {
        promises.push(setProperty(key, value))
      }
    }
    await Promise.all(promises)
  }, [stateData, setProperty])

  // ===== Field Binding =====
  const createFieldBinding = useCallback(<K extends keyof TState>(
    key: K,
    opts: FieldOptions = {},
  ): FieldBinding => {
    const { syncOn = 'change', debounce: fieldDebounce = debounce, transform } = opts
    fieldOptionsRef.current.set(key, opts)

    const currentValue = localFieldValues.current.has(key)
      ? localFieldValues.current.get(key)
      : stateData[key]

    return {
      name: String(key),
      value: toInputValue(currentValue),

      onChange: (e: FieldChangeEvent) => {
        let value: unknown = e.target.value
        if (e.target.type === 'checkbox') value = e.target.checked
        if (transform) value = transform(value)

        localFieldValues.current.set(key, value)
        setLocalVersion(v => v + 1)
        pendingChanges.current.set(key, { value, synced: false })

        if (syncOn === 'change') {
          const timer = debounceTimers.current.get(key)
          if (timer) clearTimeout(timer)
          debounceTimers.current.set(key, setTimeout(async () => {
            await setProperty(key, value)
            localFieldValues.current.delete(key)
          }, fieldDebounce))
        }
      },

      onBlur: () => {
        if (syncOn === 'blur') {
          const value = localFieldValues.current.get(key)
          if (value !== undefined && value !== stateData[key]) {
            setProperty(key, value).then(() => {
              localFieldValues.current.delete(key)
            })
          }
        }
      },
    }
  }, [stateData, debounce, setProperty, localVersion])

  // ===== Register with WebSocket =====
  // Minimal deps — this effect must only re-run when componentId changes.
  // All other values are read from refs (handlersRef, persistMetaRef, binaryDecoderRef)
  // to prevent unregister/register churn on every state update.
  useEffect(() => {
    if (!componentId) return

    const unregister = registerComponent(componentId, (message: WebSocketResponse) => {
      // Message routed via connection's map may arrive in the gap between
      // unmount and unregister(). Dropping it avoids poisoning zustand with
      // state that will resurface on the next mount.
      if (!hookAliveRef.current) return
      const persistSigned = (signedState: unknown) => {
        const { persistEnabled: pe, componentName: cn, room: r, userId: u } = persistMetaRef.current
        persistState(pe, cn, signedState, r, u)
      }
      switch (message.type) {
        case 'STATE_UPDATE': {
          const update = readStateUpdate(message)
          if (update) {
            const oldState = store.getState().state
            // Estado completo vindo do servidor: chaves do estado deste componente.
            const newState = update.state as TState
            updateState(newState)
            handlersRef.current.onStateChange?.(newState, oldState)
            if (update.signedState) persistSigned(update.signedState)
          }
          break
        }
        case 'STATE_DELTA': {
          const delta = readStateDelta(message)
          if (delta) {
            const oldState = store.getState().state
            const mergedState = deepMerge(oldState, delta)
            updateState(mergedState)
            handlersRef.current.onStateChange?.(mergedState, oldState)
          }
          break
        }
        case 'STATE_SIGNATURE': {
          // Renovação throttled da assinatura (depois de deltas). Persistir a mais
          // recente: a re-hidratação reenvia o que estiver salvo — com a do mount o
          // componente voltaria ao estado inicial.
          const signed = readStateSignature(message)
          if (signed) persistSigned(signed)
          break
        }
        case 'STATE_REHYDRATED': {
          const rehydrated = readStateRehydrated(message)
          if (rehydrated) {
            setComponentId(rehydrated.newComponentId)
            lastComponentIdRef.current = rehydrated.newComponentId
            updateState(rehydrated.state as TState)
            // Nova assinatura (versão+1): a próxima re-hidratação parte dela.
            if (rehydrated.signedState) persistSigned(rehydrated.signedState)
            setRehydrating(false)
            handlersRef.current.onRehydrate?.()
          }
          break
        }
        case 'BROADCAST': {
          const broadcast = readBroadcast(message)
          if (broadcast) broadcastHandlerRef.current?.(broadcast)
          break
        }
        case 'ERROR': {
          // O servidor põe `error` no topo; eventos emit('ERROR') trazem em payload.error.
          const errorText = readErrorMessage(message) || 'Unknown error'
          setError(errorText)
          handlersRef.current.onError?.(errorText)
          break
        }
        case 'ROOM_EVENT':
        case 'ROOM_STATE':
        case 'ROOM_SYSTEM':
        case 'ROOM_JOINED':
        case 'ROOM_LEFT':
          // Frames de sala (JSON) chegam com roomId/event/data no topo.
          for (const handler of roomMessageHandlers.current) {
            handler(message as WebSocketResponse & RoomServerMessage)
          }
          break
      }
    })

    // Register binary handler if a binaryDecoder is provided (read via ref so
    // swapping the decoder does not force re-registration).
    let unregisterBinary: (() => void) | undefined
    if (binaryDecoderRef.current) {
      unregisterBinary = registerBinaryHandler(componentId, (payload: Uint8Array) => {
        try {
          const decoder = binaryDecoderRef.current
          if (!decoder) return
          const delta = decoder(payload)
          const oldState = store.getState().state
          const mergedState = deepMerge(oldState, delta)
          updateState(mergedState)
          handlersRef.current.onStateChange?.(mergedState, oldState)
        } catch (e) {
          console.error('Binary decode error:', e)
        }
      })
    }

    return () => {
      unregister()
      unregisterBinary?.()
    }
  }, [componentId, registerComponent, registerBinaryHandler, updateState])

  // Tracks whether this hook instance is still mounted. Set false in the
  // final cleanup effect. Async callbacks (rehydrate().then, setTimeout)
  // consult this before calling into mount/setState paths, so that a fast
  // unmount (Strict Mode, route change mid-flight) cannot resurrect state
  // on a disposed instance.
  const hookAliveRef = useRef(true)

  // ===== Auto Mount =====
  useEffect(() => {
    if (connected && autoMount && !mountedRef.current && !componentId && !mountingRef.current && !rehydrating && !mountFailed) {
      rehydrate().then(ok => {
        if (!hookAliveRef.current) return
        if (!ok && !mountedRef.current && !mountFailed) mount()
      })
    }
  }, [connected, autoMount, mount, componentId, rehydrating, rehydrate, mountFailed])

  // ===== Auto Re-mount on Auth Change =====
  const prevAuthRef = useRef(wsAuthenticated)
  useEffect(() => {
    const wasNotAuthenticated = !prevAuthRef.current
    const isNowAuthenticated = wsAuthenticated
    prevAuthRef.current = wsAuthenticated

    if (wasNotAuthenticated && isNowAuthenticated && authDenied) {
      log('Auth changed to authenticated, retrying mount...')
      setAuthDenied(false)
      setMountFailed(false)
      setError(null)
      mountedRef.current = false
      mountingRef.current = false
      const timer = setTimeout(() => {
        if (!hookAliveRef.current) return
        mountFnRef.current?.()
      }, 50)
      return () => clearTimeout(timer)
    }
  }, [wsAuthenticated, authDenied, log])

  // ===== Connection Changes =====
  const prevConnected = useRef(connected)
  useEffect(() => {
    if (prevConnected.current && !connected && mountedRef.current) {
      mountedRef.current = false
      setComponentId(null)
      onDisconnect?.()
    }
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    if (!prevConnected.current && connected) {
      onConnect?.()
      if (!mountedRef.current && !mountingRef.current) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null
          if (!hookAliveRef.current) return
          const persisted = getPersistedState(persistEnabled, componentName)
          if (persisted?.signedState) {
            // Re-hidratação recusada (assinatura vencida, componente mudou...) → mount normal.
            rehydrate().then(ok => {
              if (!ok && hookAliveRef.current && !mountedRef.current) mount()
            })
          } else mount()
        }, 100)
      }
    }
    prevConnected.current = connected
    return () => {
      if (reconnectTimer) clearTimeout(reconnectTimer)
    }
  }, [connected, mount, rehydrate, componentName, onConnect, onDisconnect])

  // ===== Room Manager =====
  const roomManager = useMemo(() => {
    if (roomManagerRef.current) {
      roomManagerRef.current.setComponentId(componentId)
      return roomManagerRef.current
    }

    const manager = new RoomManager<TRoomState, TRoomEvents>({
      componentId,
      defaultRoom: room,
      sendMessage,
      sendMessageAndWait,
      onMessage: (handler) => {
        roomMessageHandlers.current.add(handler)
        return () => { roomMessageHandlers.current.delete(handler) }
      },
      onBinaryMessage: (handler) => {
        return registerRoomBinaryHandler(handler)
      },
    })

    roomManagerRef.current = manager
    return manager
  }, [componentId, room, sendMessage, sendMessageAndWait, registerRoomBinaryHandler])

  useEffect(() => {
    roomManagerRef.current?.setComponentId(componentId)
  }, [componentId])

  // ===== Room Manager Subscriptions (survives React Strict Mode remount) =====
  useEffect(() => {
    roomManagerRef.current?.resubscribe()
    return () => {
      roomManagerRef.current?.destroy()
    }
  }, [roomManager])

  // ===== Cleanup =====
  // Defer unmount via microtask/timeout so React Strict Mode's
  // mount → unmount → remount cycle doesn't tear down the server-side
  // component between the two mounts. If the component remounts before
  // the timeout fires, we cancel the pending unmount.
  const pendingUnmountRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    // Remount: re-arm liveness and cancel any pending unmount.
    hookAliveRef.current = true
    if (pendingUnmountRef.current) {
      clearTimeout(pendingUnmountRef.current)
      pendingUnmountRef.current = null
    }
    return () => {
      hookAliveRef.current = false
      debounceTimers.current.forEach(t => clearTimeout(t))
      if (mountedRef.current) {
        pendingUnmountRef.current = setTimeout(() => {
          pendingUnmountRef.current = null
          if (mountedRef.current) unmount()
        }, 0)
      }
    }
  }, [unmount])

  // ===== Status =====
  const getStatus = () => computeStatus({
    connected,
    rehydrating,
    loading,
    error,
    componentId,
  })

  // ===== Proxy =====
  const proxy = useMemo(() => {
    return new Proxy({} as LiveProxyWithBroadcasts<TState, TActions, TBroadcasts, TRoomState, TRoomEvents>, {
      get(_, prop: string | symbol) {
        if (typeof prop === 'symbol') {
          if (prop === Symbol.toStringTag) return 'LiveComponent'
          return undefined
        }

        switch (prop) {
          case '$state': return storeRef.current?.getState().state ?? stateData
          case '$connected': return connected
          case '$ready': return getStatus() === 'synced'
          case '$loading': return loading
          case '$error': return error
          case '$status': return getStatus()
          case '$componentId': return componentId
          case '$dirty': return pendingChanges.current.size > 0
          case '$authenticated': return wsAuthenticated
          case '$auth': return wsAuth
          case '$call': return call
          case '$callAndWait': return callAndWait
          case '$fire': return fire
          case '$mount': return mount
          case '$unmount': return unmount
          case '$refresh': return refresh
          case '$set': return setProperty
          case '$field': return createFieldBinding
          case '$sync': return sync
          case '$onBroadcast': return (handler: (event: LiveBroadcastEvent) => void) => {
            broadcastHandlerRef.current = handler
          }
          case '$updateLocal': return (updates: Partial<TState>) => {
            const currentState = storeRef.current?.getState().state
            if (currentState) updateState({ ...currentState, ...updates } as TState)
          }
          case '$room': return roomManager.createProxy()
          case '$rooms': return roomManager.getJoinedRooms()
        }

        // State property
        if (prop in stateData) {
          if (localFieldValues.current.has(prop as keyof TState)) {
            return localFieldValues.current.get(prop as keyof TState)
          }
          if (optimistic) {
            const pending = pendingChanges.current.get(prop as keyof TState)
            if (pending && !pending.synced) return pending.value
          }
          return stateData[prop as keyof TState]
        }

        // Action (anything not in state or reserved)
        return async (...args: unknown[]) => {
          // Footgun guard (issue #49): actions forward a SINGLE payload object.
          // Calling `list.spawn(a, b)` silently drops `b` (becomes undefined on
          // the server). TS can't catch it because the method signature on the
          // class is the dev's own. Warn loudly in dev; zero cost in prod.
          if (process.env.NODE_ENV !== 'production' && args.length > 1) {
            console.warn(
              `[live-react] action "${String(prop)}" was called with ${args.length} positional ` +
              `arguments, but Live actions forward only ONE payload object — the rest are dropped. ` +
              `Use a single object: ${String(prop)}({ ... }) and read it as the first parameter on the server.`,
            )
          }
          const payload = args[0]
          const id = componentId || lastComponentIdRef.current
          if (!id || !connected) throw notReadyError(prop)

          const response = await sendMessageAndWait(clientMessages.callAction(id, prop, payload), 10000)

          if (!response.success) throw new Error(response.error || 'Action failed')
          return response.result
        }
      },

      set(_, prop: string | symbol, value) {
        if (typeof prop === 'symbol' || RESERVED_PROPS.has(prop as string)) return false
        setProperty(prop as keyof TState, value)
        return true
      },

      has(_, prop) {
        if (typeof prop === 'symbol') return false
        return RESERVED_PROPS.has(prop) || prop in stateData
      },

      ownKeys() {
        return [
          ...Object.keys(stateData),
          '$state', '$connected', '$ready', '$loading', '$error', '$status', '$componentId', '$dirty', '$authenticated', '$auth',
          '$call', '$callAndWait', '$fire', '$mount', '$unmount', '$refresh', '$set', '$field', '$sync',
          '$onBroadcast', '$updateLocal', '$room', '$rooms',
        ]
      },
    })
  }, [stateData, connected, wsAuthenticated, loading, error, componentId, call, callAndWait, fire, mount, unmount, refresh, setProperty, optimistic, sendMessageAndWait, createFieldBinding, sync, localVersion, roomManager])

  return proxy
}

/** Converte o valor do estado para o que `<input value>` aceita (o React stringifica o resto). */
function toInputValue(value: unknown): FieldInputValue {
  if (typeof value === 'string' || typeof value === 'number') return value
  if (Array.isArray(value) && value.every((v): v is string => typeof v === 'string')) return value
  if (value === null || value === undefined) return ''
  return String(value)
}

// ===== Factory =====

export function createLiveComponent<
  TState extends object,
  TActions = {},
  TBroadcasts extends object = DefaultEventMap,
  TRoomState = DefaultRoomState,
  TRoomEvents extends object = DefaultEventMap
>(
  componentName: string,
  defaultOptions: Omit<UseLiveComponentOptions<TState>, keyof HybridComponentOptions<TState>> = {},
) {
  return function useComponent(
    initialState: TState,
    options: UseLiveComponentOptions<TState> = {},
  ): LiveProxyWithBroadcasts<TState, TActions, TBroadcasts, TRoomState, TRoomEvents> {
    return useLiveComponent<TState, TActions, TBroadcasts, TRoomState, TRoomEvents>(componentName, initialState, { ...defaultOptions, ...options })
  }
}
