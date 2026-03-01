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
} from '@fluxstack/live-client'
import type { RoomProxy, RoomServerMessage } from '@fluxstack/live-client'
import type { WebSocketResponse } from '@fluxstack/live'

// ===== Types =====

export interface FieldOptions {
  syncOn?: 'change' | 'blur' | 'manual'
  debounce?: number
  transform?: (value: any) => any
}

export interface FieldBinding {
  value: any
  onChange: (e: any) => void
  onBlur: () => void
  name: string
}

export interface LiveComponentProxy<
  TState extends Record<string, any>,
  TRoomState = any,
  TRoomEvents extends Record<string, any> = Record<string, any>
> {
  readonly $state: TState
  readonly $connected: boolean
  readonly $loading: boolean
  readonly $error: string | null
  readonly $status: 'synced' | 'disconnected' | 'connecting' | 'reconnecting' | 'loading' | 'mounting' | 'error'
  readonly $componentId: string | null
  readonly $dirty: boolean
  readonly $authenticated: boolean

  $call: (action: string, payload?: any) => Promise<void>
  $callAndWait: <R = any>(action: string, payload?: any, timeout?: number) => Promise<R>
  $mount: () => Promise<void>
  $unmount: () => Promise<void>
  $refresh: () => Promise<void>
  $set: <K extends keyof TState>(key: K, value: TState[K]) => Promise<void>
  $field: <K extends keyof TState>(key: K, options?: FieldOptions) => FieldBinding
  $sync: () => Promise<void>
  $onBroadcast: (handler: (type: string, data: any) => void) => void
  $updateLocal: (updates: Partial<TState>) => void
  readonly $room: RoomProxy<TRoomState, TRoomEvents>
  readonly $rooms: string[]
}

type BroadcastEvent<T extends Record<string, any>> = {
  [K in keyof T]: { type: K; data: T[K] }
}[keyof T]

export interface LiveComponentProxyWithBroadcasts<
  TState extends Record<string, any>,
  TBroadcasts extends Record<string, any> = Record<string, any>,
  TRoomState = any,
  TRoomEvents extends Record<string, any> = Record<string, any>
> extends Omit<LiveComponentProxy<TState, TRoomState, TRoomEvents>, '$onBroadcast'> {
  $onBroadcast: <T extends TBroadcasts = TBroadcasts>(
    handler: (event: BroadcastEvent<T>) => void
  ) => void
}

export type LiveProxy<
  TState extends Record<string, any>,
  TActions = {},
  TRoomState = any,
  TRoomEvents extends Record<string, any> = Record<string, any>
> = TState & LiveComponentProxy<TState, TRoomState, TRoomEvents> & TActions

export type LiveProxyWithBroadcasts<
  TState extends Record<string, any>,
  TActions = {},
  TBroadcasts extends Record<string, any> = Record<string, any>,
  TRoomState = any,
  TRoomEvents extends Record<string, any> = Record<string, any>
> = TState & LiveComponentProxyWithBroadcasts<TState, TBroadcasts, TRoomState, TRoomEvents> & TActions

export interface HybridComponentOptions {
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
  onStateChange?: (state: any, prevState: any) => void
}

export interface UseLiveComponentOptions extends HybridComponentOptions {
  debounce?: number
  optimistic?: boolean
  syncMode?: 'immediate' | 'debounced' | 'manual'
  persistState?: boolean
  debugLabel?: string
}

// ===== Reserved Props =====

const RESERVED_PROPS = new Set([
  '$state', '$connected', '$loading', '$error', '$status', '$componentId', '$dirty', '$authenticated',
  '$call', '$callAndWait', '$mount', '$unmount', '$refresh', '$set', '$onBroadcast', '$updateLocal',
  '$room', '$rooms', '$field', '$sync',
  'then', 'toJSON', 'valueOf', 'toString',
  Symbol.toStringTag, Symbol.iterator,
])

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
  TState extends Record<string, any>,
  TActions = {},
  TBroadcasts extends Record<string, any> = Record<string, any>
>(
  componentName: string,
  initialState: TState,
  options: UseLiveComponentOptions = {},
): LiveProxyWithBroadcasts<TState, TActions, TBroadcasts> {
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
  } = options

  const {
    connected,
    authenticated: wsAuthenticated,
    sendMessage,
    sendMessageAndWait,
    registerComponent,
    unregisterComponent,
  } = useLiveComponents()

  // Refs
  const instanceId = useRef(`${componentName}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`)
  const storeRef = useRef<ReturnType<typeof createStore<TState>> | null>(null)
  if (!storeRef.current) storeRef.current = createStore(initialState)
  const store = storeRef.current

  const pendingChanges = useRef<Map<keyof TState, { value: any; synced: boolean }>>(new Map())
  const debounceTimers = useRef<Map<keyof TState, ReturnType<typeof setTimeout>>>(new Map())
  const localFieldValues = useRef<Map<keyof TState, any>>(new Map())
  const fieldOptionsRef = useRef<Map<keyof TState, FieldOptions>>(new Map())
  const [localVersion, setLocalVersion] = useState(0)
  const mountedRef = useRef(false)
  const mountingRef = useRef(false)
  const rehydratingRef = useRef(false)
  const lastComponentIdRef = useRef<string | null>(null)
  const broadcastHandlerRef = useRef<((event: { type: string; data: any }) => void) | null>(null)
  const roomMessageHandlers = useRef<Set<(msg: RoomServerMessage) => void>>(new Set())
  const roomManagerRef = useRef<RoomManager | null>(null)
  const mountFnRef = useRef<(() => Promise<void>) | null>(null)

  // State
  const stateData = store((s) => s.state)
  const updateState = store((s) => s.updateState)
  const [componentId, setComponentId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rehydrating, setRehydrating] = useState(false)
  const [mountFailed, setMountFailed] = useState(false)
  const [authDenied, setAuthDenied] = useState(false)

  const log = useCallback((msg: string, data?: any) => {
    if (debug) console.log(`[${componentName}] ${msg}`, data || '')
  }, [debug, componentName])

  // ===== Set Property =====
  const setProperty = useCallback(async <K extends keyof TState>(key: K, value: TState[K]) => {
    const timer = debounceTimers.current.get(key)
    if (timer) clearTimeout(timer)

    pendingChanges.current.set(key, { value, synced: false })

    const doSync = async () => {
      try {
        const id = componentId || lastComponentIdRef.current
        if (!id || !connected) return

        await sendMessageAndWait({
          type: 'CALL_ACTION',
          componentId: id,
          action: 'setValue',
          payload: { key, value },
        }, 5000)

        pendingChanges.current.get(key)!.synced = true
      } catch (err: any) {
        pendingChanges.current.delete(key)
        setError(err.message)
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
      const response = await sendMessageAndWait({
        type: 'COMPONENT_MOUNT',
        componentId: instanceId.current,
        payload: { component: componentName, props: initialState, room, userId, debugLabel: options.debugLabel },
      }, 5000)

      if (response?.success && response?.result?.componentId) {
        const newId = response.result.componentId
        setComponentId(newId)
        lastComponentIdRef.current = newId
        mountedRef.current = true

        if (response.result.signedState) {
          persistState(persistEnabled, componentName, response.result.signedState, room, userId)
        }
        if (response.result.initialState) {
          updateState(response.result.initialState)
        }

        log('Mounted', newId)
        setTimeout(() => onMount?.(), 0)
      } else {
        throw new Error(response?.error || 'Mount failed')
      }
    } catch (err: any) {
      setError(err.message)
      if (err.message?.includes('AUTH_DENIED')) setAuthDenied(true)
      setMountFailed(true)
      onError?.(err.message)
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
      await sendMessage({ type: 'COMPONENT_UNMOUNT', componentId })
      setComponentId(null)
      mountedRef.current = false
    } catch {}
  }, [componentId, connected, sendMessage])

  // ===== Rehydrate =====
  const rehydrate = useCallback(async () => {
    if (!connected || rehydratingRef.current || mountingRef.current || mountedRef.current) return false

    const persisted = getPersistedState(persistEnabled, componentName)
    if (!persisted) return false

    if (Date.now() - persisted.lastUpdate > 60 * 60 * 1000) {
      clearPersistedState(persistEnabled, componentName)
      return false
    }

    rehydratingRef.current = true
    setRehydrating(true)
    try {
      const response = await sendMessageAndWait({
        type: 'COMPONENT_REHYDRATE',
        componentId: lastComponentIdRef.current || instanceId.current,
        payload: {
          componentName,
          signedState: persisted.signedState,
          room: persisted.room,
          userId: persisted.userId,
        },
      }, 2000)

      if (response?.success && response?.result?.newComponentId) {
        setComponentId(response.result.newComponentId)
        lastComponentIdRef.current = response.result.newComponentId
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
  }, [connected, componentName, sendMessageAndWait, onRehydrate])

  // ===== Call Action =====
  const call = useCallback(async (action: string, payload?: any) => {
    const id = componentId || lastComponentIdRef.current
    if (!id || !connected) throw new Error('Not connected')

    const response = await sendMessageAndWait({
      type: 'CALL_ACTION',
      componentId: id,
      action,
      payload,
    }, 5000)

    if (!response.success) throw new Error(response.error || 'Action failed')
  }, [componentId, connected, sendMessageAndWait])

  const callAndWait = useCallback(async <R = any>(action: string, payload?: any, timeout = 10000): Promise<R> => {
    const id = componentId || lastComponentIdRef.current
    if (!id || !connected) throw new Error('Not connected')

    const response = await sendMessageAndWait({
      type: 'CALL_ACTION',
      componentId: id,
      action,
      payload,
    }, timeout)

    return response as R
  }, [componentId, connected, sendMessageAndWait])

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
      value: currentValue ?? '',

      onChange: (e: any) => {
        let value: any = e.target.value
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
  useEffect(() => {
    if (!componentId) return

    const unregister = registerComponent(componentId, (message: WebSocketResponse) => {
      switch (message.type) {
        case 'STATE_UPDATE':
          if (message.payload?.state) {
            const oldState = stateData
            updateState(message.payload.state)
            onStateChange?.(message.payload.state, oldState)
            if (message.payload?.signedState) {
              persistState(persistEnabled, componentName, message.payload.signedState, room, userId)
            }
          }
          break
        case 'STATE_DELTA':
          if (message.payload?.delta) {
            const oldState = storeRef.current?.getState().state ?? stateData
            const mergedState = { ...oldState, ...message.payload.delta } as TState
            updateState(mergedState)
            onStateChange?.(mergedState, oldState)
          }
          break
        case 'STATE_REHYDRATED':
          if (message.payload?.state && message.payload?.newComponentId) {
            setComponentId(message.payload.newComponentId)
            lastComponentIdRef.current = message.payload.newComponentId
            updateState(message.payload.state)
            setRehydrating(false)
            onRehydrate?.()
          }
          break
        case 'BROADCAST':
          if (message.payload?.type) {
            broadcastHandlerRef.current?.({ type: message.payload.type, data: message.payload.data })
          }
          break
        case 'ERROR':
          setError(message.payload?.error || 'Unknown error')
          onError?.(message.payload?.error)
          break
        case 'ROOM_EVENT':
        case 'ROOM_STATE':
        case 'ROOM_SYSTEM':
        case 'ROOM_JOINED':
        case 'ROOM_LEFT':
          for (const handler of roomMessageHandlers.current) {
            handler(message as unknown as RoomServerMessage)
          }
          break
      }
    })

    return () => unregister()
  }, [componentId, registerComponent, updateState, stateData, componentName, room, userId, onStateChange, onRehydrate, onError])

  // ===== Auto Mount =====
  useEffect(() => {
    if (connected && autoMount && !mountedRef.current && !componentId && !mountingRef.current && !rehydrating && !mountFailed) {
      rehydrate().then(ok => {
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
      setTimeout(() => mountFnRef.current?.(), 50)
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
    if (!prevConnected.current && connected) {
      onConnect?.()
      if (!mountedRef.current && !mountingRef.current) {
        setTimeout(() => {
          const persisted = getPersistedState(persistEnabled, componentName)
          if (persisted?.signedState) rehydrate()
          else mount()
        }, 100)
      }
    }
    prevConnected.current = connected
  }, [connected, mount, rehydrate, componentName, onConnect, onDisconnect])

  // ===== Room Manager =====
  const roomManager = useMemo(() => {
    if (roomManagerRef.current) {
      roomManagerRef.current.setComponentId(componentId)
      return roomManagerRef.current
    }

    const manager = new RoomManager({
      componentId,
      defaultRoom: room,
      sendMessage,
      sendMessageAndWait,
      onMessage: (handler) => {
        roomMessageHandlers.current.add(handler)
        return () => { roomMessageHandlers.current.delete(handler) }
      },
    })

    roomManagerRef.current = manager
    return manager
  }, [componentId, room, sendMessage, sendMessageAndWait])

  useEffect(() => {
    roomManagerRef.current?.setComponentId(componentId)
  }, [componentId])

  // ===== Cleanup =====
  useEffect(() => {
    return () => {
      debounceTimers.current.forEach(t => clearTimeout(t))
      roomManagerRef.current?.destroy()
      if (mountedRef.current) unmount()
    }
  }, [unmount])

  // ===== Status =====
  const getStatus = () => {
    if (!connected) return 'connecting'
    if (rehydrating) return 'reconnecting'
    if (loading) return 'loading'
    if (error) return 'error'
    if (!componentId) return 'mounting'
    return 'synced'
  }

  // ===== Proxy =====
  const proxy = useMemo(() => {
    return new Proxy({} as LiveProxyWithBroadcasts<TState, TActions, TBroadcasts>, {
      get(_, prop: string | symbol) {
        if (typeof prop === 'symbol') {
          if (prop === Symbol.toStringTag) return 'LiveComponent'
          return undefined
        }

        switch (prop) {
          case '$state': return storeRef.current?.getState().state ?? stateData
          case '$connected': return connected
          case '$loading': return loading
          case '$error': return error
          case '$status': return getStatus()
          case '$componentId': return componentId
          case '$dirty': return pendingChanges.current.size > 0
          case '$authenticated': return wsAuthenticated
          case '$call': return call
          case '$callAndWait': return callAndWait
          case '$mount': return mount
          case '$unmount': return unmount
          case '$refresh': return refresh
          case '$set': return setProperty
          case '$field': return createFieldBinding
          case '$sync': return sync
          case '$onBroadcast': return (handler: (event: { type: string; data: any }) => void) => {
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
        return async (payload?: any) => {
          const id = componentId || lastComponentIdRef.current
          if (!id || !connected) throw new Error('Not connected')

          const response = await sendMessageAndWait({
            type: 'CALL_ACTION',
            componentId: id,
            action: prop,
            payload,
          }, 10000)

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
          '$state', '$connected', '$loading', '$error', '$status', '$componentId', '$dirty', '$authenticated',
          '$call', '$callAndWait', '$mount', '$unmount', '$refresh', '$set', '$field', '$sync',
          '$onBroadcast', '$updateLocal', '$room', '$rooms',
        ]
      },
    })
  }, [stateData, connected, wsAuthenticated, loading, error, componentId, call, callAndWait, mount, unmount, refresh, setProperty, optimistic, sendMessageAndWait, createFieldBinding, sync, localVersion, roomManager])

  return proxy
}

// ===== Factory =====

export function createLiveComponent<
  TState extends Record<string, any>,
  TActions = {},
  TBroadcasts extends Record<string, any> = Record<string, any>
>(
  componentName: string,
  defaultOptions: Omit<UseLiveComponentOptions, keyof HybridComponentOptions> = {},
) {
  return function useComponent(
    initialState: TState,
    options: UseLiveComponentOptions = {},
  ): LiveProxyWithBroadcasts<TState, TActions, TBroadcasts> {
    return useLiveComponent<TState, TActions, TBroadcasts>(componentName, initialState, { ...defaultOptions, ...options })
  }
}
