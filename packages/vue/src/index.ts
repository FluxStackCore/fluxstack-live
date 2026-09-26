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
  shallowRef,
  inject,
  provide,
  onMounted,
  onUnmounted,
  type InjectionKey,
  type Ref,
  type DeepReadonly,
} from 'vue'

import {
  LiveConnection,
  clientMessages,
  clearPersistedState,
  getRehydratableState,
  persistState,
  readErrorMessage,
  readMountResult,
  readRehydrateResult,
  readStateDelta,
  readStateRehydrated,
  readStateSignature,
  readStateUpdate,
  toRecord,
} from '@fluxstack/live-client'
import type { LiveConnectionOptions, LiveConnectionState, LiveAuthOptions, ClientTransportKind } from '@fluxstack/live-client'

// ===== Deep Merge (handles null-as-deletion for STATE_DELTA) =====

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    && Object.getPrototypeOf(v) === Object.prototype
}

/**
 * Apply a STATE_DELTA coming from the server (mutates target).
 *
 * Semantics (matches core's `deepAssign`, fixes #6):
 * - Top-level (depth === 0): `null` is a real value — `target[key] = null`.
 *   Top-level state keys are part of the component schema and are not
 *   dynamically added/removed, so there is no ambiguity with a deletion
 *   signal. This is what makes `Nullable<T>` fields in state work.
 * - Nested (depth > 0): `null` is the deletion sentinel from the core's
 *   `computeDeepDiff` — remove the key. This is what the
 *   `Record<string, T>` scenario from issue #1/#3 relies on.
 * - `undefined` is a no-op (skipped) — these values never cross the wire.
 */
function deepMerge(target: object, source: Record<string, unknown>, seen?: Set<object>): void {
  // Muta o objeto reativo no lugar (não dá para copiar): a visão como Record é só para indexar.
  deepMergeImpl(target as Record<string, unknown>, source, 0, seen)
}

function deepMergeImpl(target: Record<string, unknown>, source: Record<string, unknown>, depth: number, seen?: Set<object>): void {
  if (!seen) seen = new Set()
  if (seen.has(source)) return
  seen.add(source)

  for (const key of Object.keys(source)) {
    const newVal = source[key]
    if (newVal === undefined) continue
    if (newVal === null) {
      if (depth === 0) {
        target[key] = null
      } else {
        delete target[key]
      }
      continue
    }
    const oldVal = target[key]
    if (isPlainObject(oldVal) && isPlainObject(newVal)) {
      deepMergeImpl(oldVal, newVal, depth + 1, seen)
    } else {
      target[key] = newVal
    }
  }
}
import type { SignedState, WebSocketResponse } from '@fluxstack/live'
import { generateId } from '@fluxstack/live-client'

// ===== Connection Provider (equivalent to React Context) =====

export interface LiveConnectionContext {
  connection: LiveConnection
  connected: Ref<boolean>
  connecting: Ref<boolean>
  error: Ref<string | null>
  connectionId: Ref<string | null>
  authenticated: Ref<boolean>
  /** Transporte que abriu por último ('websocket' | 'sse' | 'http' | custom) — null antes da 1ª conexão */
  transport: Ref<ClientTransportKind | null>
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
  const transport = ref<ClientTransportKind | null>(null)

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
    transport.value = state.transport
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
    transport: readonly(transport) as Ref<ClientTransportKind | null>,
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
  /**
   * Re-hidratação de estado (padrão `true`, igual ao React). Guarda o `signedState`
   * mais recente (mount, `STATE_REHYDRATED`, renovação `STATE_SIGNATURE`) e, numa
   * reconexão, envia `COMPONENT_REHYDRATE` para continuar do estado atual em vez de
   * remontar do zero; se o servidor recusar, cai para o mount normal. Também persiste
   * em `localStorage` (mesma chave/TTL do React) para re-hidratar depois de um reload.
   * `false` = toda (re)conexão monta do zero e nada é gravado.
   */
  persistState?: boolean
  /** Chamado depois de uma re-hidratação aceita pelo servidor. */
  onRehydrate?: () => void
}

export interface UseLiveComponentReturn<TState extends object> {
  /** Reactive component state (read-only). Use in templates directly: `state.count` */
  state: DeepReadonly<TState>
  /** Whether the component is mounted on the server */
  mounted: Ref<boolean>
  /** Whether the component is currently mounting */
  mounting: Ref<boolean>
  /** Re-hidratação (`COMPONENT_REHYDRATE`) em andamento */
  rehydrating: Ref<boolean>
  /** Whether connected to the WebSocket server */
  connected: Ref<boolean>
  /** Last error message */
  error: Ref<string | null>
  /** Server-assigned component ID */
  componentId: Ref<string | null>
  /** signedState mais recente recebido do servidor (o que a re-hidratação reenvia) */
  signedState: Ref<SignedState | null>
  /** Call a server action */
  call: <R = unknown>(action: string, payload?: unknown) => Promise<R>
  /** Manually mount the component */
  mount: () => Promise<void>
  /** Unmount the component */
  unmount: () => Promise<void>
}

/** Resultado de uma tentativa de re-hidratação. */
type RehydrateOutcome =
  | 'ok'
  /** nada para reenviar (desligado, sem token) */
  | 'none'
  /** servidor recusou (assinatura inválida/vencida, classe mudou...) — token descartado */
  | 'refused'
  /** a conexão caiu/trocou no meio: token mantido, tentar de novo na conexão nova */
  | 'stale'

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
export function useLiveComponent<TState extends object>(
  componentName: string,
  initialState: TState,
  options: UseLiveComponentOptions = {},
): UseLiveComponentReturn<TState> {
  const {
    room,
    userId,
    autoMount = true,
    debug = false,
    persistState: persistEnabled = true,
    onRehydrate,
  } = options

  const { connection, connected, connectionId: connectionIdRef } = useLiveConnection()

  // Reactive state
  const state = reactive<TState>({ ...initialState }) as TState
  const isMounted = ref(false)
  const isMounting = ref(false)
  const isRehydrating = ref(false)
  const componentError = ref<string | null>(null)
  const componentId = ref<string | null>(null)
  const latestSigned = shallowRef<SignedState | null>(null)

  const instanceId = generateId()

  let unregisterComponent: (() => void) | null = null
  let unsubConnection: (() => void) | null = null
  /** o componente Vue já foi desmontado — um mount que responda depois é desfeito */
  let disposed = false
  /** último componentId do servidor (vai como `componentId` do COMPONENT_REHYDRATE) */
  let lastComponentId: string | null = null
  /** connectionId sob o qual o componente atual foi montado/re-hidratado */
  let boundConnectionId: string | null = null
  /** fluxo conectar (rehydrate → mount) em andamento */
  let connecting: Promise<void> | null = null

  function log(msg: string, data?: unknown) {
    if (debug) console.log(`[Live:${componentName}] ${msg}`, data ?? '')
  }

  /** Guarda o signedState mais recente (memória + localStorage, se ligado). */
  function rememberSigned(signed: SignedState | undefined | null) {
    if (!signed) return
    latestSigned.value = signed
    persistState(persistEnabled, componentName, signed, room, userId)
  }

  function forgetSigned() {
    latestSigned.value = null
    clearPersistedState(persistEnabled, componentName)
  }

  // Handle server messages (state sync)
  function handleServerMessage(msg: WebSocketResponse) {
    switch (msg.type) {
      case 'STATE_UPDATE': {
        const update = readStateUpdate(msg)
        if (update) {
          deepMerge(state, update.state)
          rememberSigned(update.signedState)
          log('State update', update.state)
        }
        break
      }
      case 'STATE_DELTA': {
        const delta = readStateDelta(msg)
        if (delta) {
          deepMerge(state, delta)
          log('State delta', delta)
        }
        break
      }
      case 'STATE_SIGNATURE': {
        // Renovação throttled: sem ela a re-hidratação voltaria ao estado do mount.
        rememberSigned(readStateSignature(msg))
        break
      }
      case 'STATE_REHYDRATED': {
        const rehydrated = readStateRehydrated(msg)
        if (rehydrated) {
          Object.assign(state, rehydrated.state)
          rememberSigned(rehydrated.signedState)
          log('State rehydrated', rehydrated.state)
        }
        break
      }
      case 'ERROR': {
        const err = readErrorMessage(msg) || 'Unknown error'
        componentError.value = err
        log('Error', err)
        break
      }
    }
  }

  /** Liga o composable a um componente do servidor (mount ou rehydrate aceitos). */
  function bindComponent(id: string) {
    componentId.value = id
    lastComponentId = id
    boundConnectionId = connection.state.connectionId
    isMounted.value = true
    // Mensagens que chegaram antes do registro (ex.: STATE_REHYDRATED) são entregues aqui.
    unregisterComponent = connection.registerComponent(id, handleServerMessage)
  }

  /** Esquece o componente local (o do servidor morreu com a conexão). */
  function dropLocalMount() {
    if (unregisterComponent) {
      unregisterComponent()
      unregisterComponent = null
    }
    componentId.value = null
    boundConnectionId = null
    isMounted.value = false
  }

  const busy = () => isMounted.value || isMounting.value || isRehydrating.value
  /** Cada (re)conexão cria um transporte novo: identidade dele = "época" da conexão. */
  const connectionEpoch = () => connection.getTransport()

  // Mount
  async function mountComponent() {
    if (busy()) return
    if (!connected.value) return

    isMounting.value = true
    componentError.value = null
    log('Mounting...')

    try {
      const response = await connection.sendMessageAndWait(
        clientMessages.mount(instanceId, {
          component: componentName,
          props: toRecord(initialState),
          room,
          userId,
        }),
        5000,
      )

      if (!response.success) {
        throw new Error(response.error || 'Mount failed')
      }

      const result = readMountResult(response)
      if (!result) throw new Error('Mount failed: malformed server response')

      // Desmontado enquanto o mount estava em voo: desfaz no servidor em vez
      // de registrar um componente que ninguém mais vai desmontar (vazamento).
      if (disposed) {
        connection.sendMessage(clientMessages.unmount(result.componentId)).catch(() => {})
        return
      }

      // Estado inicial ANTES de registrar: o registro entrega mensagens que chegaram
      // antes da resposta (ex.: delta do onMount), que são mais novas que ele.
      if (result.initialState) {
        Object.assign(state, result.initialState)
      }
      rememberSigned(result.signedState)
      bindComponent(result.componentId)

      log('Mounted', { componentId: result.componentId })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      componentError.value = message
      log('Mount failed', message)
    } finally {
      isMounting.value = false
    }
  }

  // Rehydrate (COMPONENT_REHYDRATE com o signedState mais recente)
  async function rehydrateComponent(): Promise<RehydrateOutcome> {
    if (!persistEnabled || busy() || !connected.value) return 'none'

    // Memória (reconexão) primeiro; senão o que sobreviveu a um reload.
    const persisted = latestSigned.value ? null : getRehydratableState(persistEnabled, componentName)
    const signedState = latestSigned.value ?? persisted?.signedState
    if (!signedState) return 'none'

    const startedOn = connectionEpoch()
    isRehydrating.value = true
    log('Rehydrating...', { version: signedState.version })

    try {
      const response = await connection.sendMessageAndWait(
        clientMessages.rehydrate(lastComponentId ?? instanceId, {
          component: componentName,
          signedState,
          room: room ?? persisted?.room,
          userId: userId ?? persisted?.userId,
        }),
        5000,
      )
      const result = response.success ? readRehydrateResult(response) : null
      if (!result) throw new Error(response.error || 'Rehydrate failed')

      if (disposed) {
        connection.sendMessage(clientMessages.unmount(result.newComponentId)).catch(() => {})
        return 'ok'
      }

      componentError.value = null
      bindComponent(result.newComponentId)
      log('Rehydrated', { componentId: result.newComponentId })
      onRehydrate?.()
      return 'ok'
    } catch (err) {
      // A conexão caiu/trocou no meio: não foi recusa, o token continua bom.
      if (!connection.state.connected || connectionEpoch() !== startedOn) {
        log('Rehydrate interrupted by reconnection', err)
        return 'stale'
      }
      log('Rehydrate refused, falling back to mount', err instanceof Error ? err.message : err)
      forgetSigned()
      return 'refused'
    } finally {
      isRehydrating.value = false
    }
  }

  /** Re-hidrata se houver token; senão (ou se recusado) monta do zero. */
  function connectComponent(): Promise<void> {
    if (connecting) return connecting
    connecting = (async () => {
      try {
        // No máximo algumas voltas: cada 'stale' é uma troca de conexão no meio do fluxo.
        for (let attempt = 0; attempt < 3; attempt++) {
          if (disposed || busy() || !connected.value) return
          const startedOn = connectionEpoch()
          const outcome = await rehydrateComponent()
          if (outcome === 'ok' || disposed) return
          if (outcome === 'stale') continue
          await mountComponent()
          // Mount perdido numa troca de conexão (timeout na conexão velha): tenta de novo.
          if (isMounted.value || !connected.value || connectionEpoch() === startedOn) return
        }
      } finally {
        connecting = null
      }
    })()
    return connecting
  }

  // Unmount
  async function unmountComponent() {
    if (!isMounted.value || !componentId.value) return

    log('Unmounting...')
    try {
      await connection.sendMessage(clientMessages.unmount(componentId.value))
    } catch {
      // ignore (connection may already be closed)
    }

    if (unregisterComponent) {
      unregisterComponent()
      unregisterComponent = null
    }
    // Desmontagem explícita: o próximo mount começa do zero (não ressuscita o antigo).
    latestSigned.value = null
    lastComponentId = null
    boundConnectionId = null
    componentId.value = null
    isMounted.value = false
  }

  // Call action
  async function callAction<R = unknown>(action: string, payload: unknown = {}): Promise<R> {
    if (!isMounted.value || !componentId.value) {
      throw new Error(`Cannot call '${action}': component not mounted`)
    }

    log(`Calling: ${action}`, payload)

    let response: WebSocketResponse
    try {
      // sendMessageAndWait rejeita quando o servidor responde success:false/ERROR
      response = await connection.sendMessageAndWait(
        clientMessages.callAction(componentId.value, action, payload),
        10000,
      )
    } catch (err) {
      componentError.value = err instanceof Error ? err.message : String(err)
      throw err
    }

    if (!response.success) {
      const errorMsg = response.error || `Action '${action}' failed`
      componentError.value = errorMsg
      throw new Error(errorMsg)
    }

    // O retorno da action é definido pelo componente do servidor; o chamador escolhe R.
    return response.result as R
  }

  // Auto-mount on connection
  if (autoMount) {
    // If already connected, mount now
    onMounted(() => {
      if (connected.value) {
        connectComponent()
      }
    })

    // Queda (connected=false) OU conexão nova (connectionId trocou — cobre uma queda e
    // volta tão rápidas que o watcher nem viu connected=false): o componente do servidor
    // morreu com a conexão antiga → re-hidrata (ou remonta) na nova.
    const stopWatch = watch([connected, connectionIdRef], ([isConnected, connId]) => {
      if (isMounted.value) {
        if (!isConnected) {
          dropLocalMount()
        } else if (connId) {
          if (!boundConnectionId) boundConnectionId = connId
          else if (connId !== boundConnectionId) dropLocalMount()
        }
      }
      if (isConnected && !busy()) {
        connectComponent()
      }
    })

    onUnmounted(() => {
      stopWatch()
    })
  }

  // Cleanup on component unmount
  onUnmounted(() => {
    disposed = true
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
    rehydrating: readonly(isRehydrating) as Ref<boolean>,
    connected,
    error: readonly(componentError) as Ref<string | null>,
    componentId: readonly(componentId) as Ref<string | null>,
    signedState: readonly(latestSigned) as Ref<SignedState | null>,
    call: callAction,
    mount: mountComponent,
    unmount: unmountComponent,
  }
}

// Short alias (preferred) - same function, easier to remember
export { useLiveComponent as useLive }

// Re-export client types for convenience
export type { LiveConnectionOptions, LiveAuthOptions } from '@fluxstack/live-client'
