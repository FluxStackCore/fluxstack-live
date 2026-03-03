// @fluxstack/live-vue - Vue 3 bindings for Live Components
//
// Usage:
//   // In App.vue (setup)
//   import { provideLiveConnection } from '@fluxstack/live-vue'
//   provideLiveConnection({ url: 'ws://localhost:3000/api/live/ws' })
//
//   // In any child component
//   import { useLive } from '@fluxstack/live-vue'
//   const { state, call, connected, error } = useLive('Counter', { count: 0 })
//   // state.count is reactive
//   // call('increment') triggers a server action

import {
  ref,
  reactive,
  readonly,
  computed,
  watch,
  inject,
  provide,
  onMounted,
  onUnmounted,
  type InjectionKey,
  type Ref,
  type DeepReadonly,
} from 'vue'

import { LiveConnection } from '@fluxstack/live-client'
import type { LiveConnectionOptions, LiveConnectionState, LiveAuthOptions } from '@fluxstack/live-client'
import type { WebSocketMessage, WebSocketResponse } from '@fluxstack/live'

// ===== Connection Provider (equivalent to React Context) =====

export interface LiveConnectionContext {
  connection: LiveConnection
  connected: Ref<boolean>
  connecting: Ref<boolean>
  error: Ref<string | null>
  connectionId: Ref<string | null>
  authenticated: Ref<boolean>
  reconnect: () => void
  authenticate: (credentials: LiveAuthOptions) => Promise<boolean>
}

const LIVE_CONNECTION_KEY: InjectionKey<LiveConnectionContext> = Symbol('fluxstack-live-connection')

/**
 * Provide a LiveConnection to all child components.
 * Call this in your root component's setup().
 *
 * @example
 * ```vue
 * <script setup>
 * import { provideLiveConnection } from '@fluxstack/live-vue'
 * provideLiveConnection({ url: 'ws://localhost:3000/api/live/ws' })
 * </script>
 * ```
 */
export function provideLiveConnection(options: LiveConnectionOptions = {}): LiveConnectionContext {
  const connected = ref(false)
  const connecting = ref(false)
  const error = ref<string | null>(null)
  const connectionId = ref<string | null>(null)
  const authenticated = ref(false)

  const connection = new LiveConnection({
    ...options,
    autoConnect: false,
  })

  const unsub = connection.onStateChange((state: LiveConnectionState) => {
    connected.value = state.connected
    connecting.value = state.connecting
    error.value = state.error
    connectionId.value = state.connectionId
    authenticated.value = state.authenticated
  })

  // Auto-connect
  if (options.autoConnect !== false) {
    connection.connect()
  }

  // Cleanup on unmount
  onUnmounted(() => {
    unsub()
    connection.destroy()
  })

  const ctx: LiveConnectionContext = {
    connection,
    connected: readonly(connected) as Ref<boolean>,
    connecting: readonly(connecting) as Ref<boolean>,
    error: readonly(error) as Ref<string | null>,
    connectionId: readonly(connectionId) as Ref<string | null>,
    authenticated: readonly(authenticated) as Ref<boolean>,
    reconnect: () => connection.reconnect(),
    authenticate: (credentials) => connection.authenticate(credentials),
  }

  provide(LIVE_CONNECTION_KEY, ctx)
  return ctx
}

/**
 * Access the LiveConnection context from a child component.
 *
 * @example
 * ```vue
 * <script setup>
 * import { useLiveConnection } from '@fluxstack/live-vue'
 * const { connected, error, reconnect } = useLiveConnection()
 * </script>
 * ```
 */
export function useLiveConnection(): LiveConnectionContext {
  const ctx = inject(LIVE_CONNECTION_KEY)
  if (!ctx) {
    throw new Error(
      'useLiveConnection() requires provideLiveConnection() in a parent component.'
    )
  }
  return ctx
}

// ===== useLiveComponent =====

export interface UseLiveComponentOptions {
  /** Room to join on mount */
  room?: string
  /** User ID for component isolation */
  userId?: string
  /** Auto-mount when connected. Default: true */
  autoMount?: boolean
  /** Enable debug logging. Default: false */
  debug?: boolean
}

export interface UseLiveComponentReturn<TState extends Record<string, any>> {
  /** Reactive component state (read-only). Use in templates directly: `state.count` */
  state: DeepReadonly<TState>
  /** Whether the component is mounted on the server */
  mounted: Ref<boolean>
  /** Whether the component is currently mounting */
  mounting: Ref<boolean>
  /** Whether connected to the WebSocket server */
  connected: Ref<boolean>
  /** Last error message */
  error: Ref<string | null>
  /** Server-assigned component ID */
  componentId: Ref<string | null>
  /** Call a server action */
  call: <R = any>(action: string, payload?: Record<string, any>) => Promise<R>
  /** Manually mount the component */
  mount: () => Promise<void>
  /** Unmount the component */
  unmount: () => Promise<void>
}

/**
 * Composable to use a Live Component in a Vue component.
 * Returns reactive state that auto-syncs with the server.
 *
 * @example
 * ```vue
 * <script setup>
 * import { useLive } from '@fluxstack/live-vue'
 *
 * const { state, call, connected, error } = useLive('Counter', {
 *   count: 0,
 *   lastAction: null,
 * })
 * </script>
 *
 * <template>
 *   <p>{{ state.count }}</p>
 *   <button @click="call('increment')">+</button>
 *   <button @click="call('decrement')">-</button>
 *   <button @click="call('reset')">Reset</button>
 *   <p v-if="error">{{ error }}</p>
 * </template>
 * ```
 */
export function useLiveComponent<TState extends Record<string, any>>(
  componentName: string,
  initialState: TState,
  options: UseLiveComponentOptions = {},
): UseLiveComponentReturn<TState> {
  const {
    room,
    userId,
    autoMount = true,
    debug = false,
  } = options

  const { connection, connected } = useLiveConnection()

  // Reactive state
  const state = reactive<TState>({ ...initialState }) as TState
  const isMounted = ref(false)
  const isMounting = ref(false)
  const componentError = ref<string | null>(null)
  const componentId = ref<string | null>(null)

  const instanceId = `${componentName}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`

  let unregisterComponent: (() => void) | null = null
  let unsubConnection: (() => void) | null = null

  function log(msg: string, data?: any) {
    if (debug) console.log(`[Live:${componentName}] ${msg}`, data ?? '')
  }

  // Handle server messages (state sync)
  function handleServerMessage(msg: WebSocketResponse) {
    switch (msg.type) {
      case 'STATE_UPDATE': {
        const newState = (msg as any).payload?.state
        if (newState) {
          Object.assign(state, newState)
          log('State update', newState)
        }
        break
      }
      case 'STATE_DELTA': {
        const delta = (msg as any).payload?.delta
        if (delta) {
          Object.assign(state, delta)
          log('State delta', delta)
        }
        break
      }
      case 'ERROR': {
        const err = (msg as any).error || 'Unknown error'
        componentError.value = err
        log('Error', err)
        break
      }
    }
  }

  // Mount
  async function mountComponent() {
    if (isMounted.value || isMounting.value) return
    if (!connected.value) return

    isMounting.value = true
    componentError.value = null
    log('Mounting...')

    try {
      const response = await connection.sendMessageAndWait({
        type: 'COMPONENT_MOUNT',
        componentId: instanceId,
        payload: {
          component: componentName,
          props: initialState,
          room,
          userId,
        },
      }, 5000)

      if (!response.success) {
        throw new Error(response.error || 'Mount failed')
      }

      const result = (response as any).result
      componentId.value = result.componentId
      isMounted.value = true

      // Merge server initial state
      if (result.initialState) {
        Object.assign(state, result.initialState)
      }

      // Register for server pushes
      unregisterComponent = connection.registerComponent(
        result.componentId,
        handleServerMessage,
      )

      log('Mounted', { componentId: result.componentId })
    } catch (err: any) {
      componentError.value = err.message
      log('Mount failed', err.message)
    } finally {
      isMounting.value = false
    }
  }

  // Unmount
  async function unmountComponent() {
    if (!isMounted.value || !componentId.value) return

    log('Unmounting...')
    try {
      await connection.sendMessage({
        type: 'COMPONENT_UNMOUNT',
        componentId: componentId.value,
      })
    } catch {
      // ignore (connection may already be closed)
    }

    if (unregisterComponent) {
      unregisterComponent()
      unregisterComponent = null
    }
    componentId.value = null
    isMounted.value = false
  }

  // Call action
  async function callAction<R = any>(action: string, payload: Record<string, any> = {}): Promise<R> {
    if (!isMounted.value || !componentId.value) {
      throw new Error(`Cannot call '${action}': component not mounted`)
    }

    log(`Calling: ${action}`, payload)

    const response = await connection.sendMessageAndWait({
      type: 'CALL_ACTION',
      componentId: componentId.value,
      action,
      payload,
    }, 10000)

    if (!response.success) {
      const errorMsg = response.error || `Action '${action}' failed`
      componentError.value = errorMsg
      throw new Error(errorMsg)
    }

    return (response as any).result
  }

  // Auto-mount on connection
  if (autoMount) {
    // If already connected, mount now
    onMounted(() => {
      if (connected.value) {
        mountComponent()
      }
    })

    // Watch for connection changes
    const stopWatch = watch(connected, (isConnected, wasConnected) => {
      if (isConnected && !isMounted.value && !isMounting.value) {
        mountComponent()
      }
      if (!isConnected && wasConnected && isMounted.value) {
        // Connection lost - reset mount state so we re-mount on reconnect
        if (unregisterComponent) {
          unregisterComponent()
          unregisterComponent = null
        }
        componentId.value = null
        isMounted.value = false
      }
    })

    onUnmounted(() => {
      stopWatch()
    })
  }

  // Cleanup on component unmount
  onUnmounted(() => {
    unmountComponent()
    if (unsubConnection) {
      unsubConnection()
      unsubConnection = null
    }
  })

  return {
    state: readonly(state) as DeepReadonly<TState>,
    mounted: readonly(isMounted) as Ref<boolean>,
    mounting: readonly(isMounting) as Ref<boolean>,
    connected,
    error: readonly(componentError) as Ref<string | null>,
    componentId: readonly(componentId) as Ref<string | null>,
    call: callAction,
    mount: mountComponent,
    unmount: unmountComponent,
  }
}

// Short alias (preferred) - same function, easier to remember
export { useLiveComponent as useLive }

// Re-export client types for convenience
export type { LiveConnectionOptions, LiveAuthOptions } from '@fluxstack/live-client'
