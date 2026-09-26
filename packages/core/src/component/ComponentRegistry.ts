// @fluxstack/live - Component Registry
//
// Enhanced component registry with lifecycle management, health monitoring,
// state signing, singleton support, and auto-discovery.

import type { AnyLiveComponent, LiveComponentClass, LiveComponentConstructorOptions } from './LiveComponent'
import { EMIT_OVERRIDE_KEY } from './LiveComponent'
import { STATE_DELTA_HOOK_KEY } from './managers/ComponentMessaging'
import { SignedStateRenewer } from './SignedStateRenewer'
import { internals } from './internals'
import type { GenericWebSocket, LiveWSData } from '../transport/types'
import { queueWsMessage, queuePreSerialized, sendImmediate } from '../transport/WsSendBatcher'
import type { LiveMessage, LiveMessageType, BroadcastMessage, ComponentDefinition, RegistryClientMessage } from '../protocol/messages'
import { isRecord } from '../protocol/validation'
import { ANONYMOUS_CONTEXT } from '../auth/LiveAuthContext'
import type { LiveAuthManager } from '../auth/LiveAuthManager'
import type { StateSignatureManager, SignedState } from '../security/StateSignature'
import type { PerformanceMonitor } from '../monitoring/PerformanceMonitor'
import { liveLog, liveWarn, registerComponentLogging, unregisterComponentLogging } from '../debug/LiveLogger'
import type { IClusterAdapter, ClusterActionRequest, ClusterActionResponse } from '../cluster/types'
import { generateId as defaultGenerateId } from '../utils/generateId'
import type { ActionCaller } from './managers/ActionSecurityManager'
import type { LiveAuthContext } from '../auth/types'
import { AuthenticatedContext } from '../auth/LiveAuthContext'
import { errorMessage, toError } from '../utils/errors'

export interface ComponentMetadata {
  id: string
  name: string
  version: string
  mountedAt: Date
  lastActivity: number
  state: 'mounting' | 'active' | 'inactive' | 'error' | 'destroying'
  healthStatus: 'healthy' | 'degraded' | 'unhealthy'
  dependencies: string[]
  services: Map<string, unknown>
  metrics: ComponentMetrics
  migrationHistory: StateMigration[]
}

export interface ComponentMetrics {
  renderCount: number
  actionCount: number
  errorCount: number
  averageRenderTime: number
  memoryUsage: number
  lastRenderTime?: number
}

export interface StateMigration {
  fromVersion: string
  toVersion: string
  migratedAt: Date
  success: boolean
  error?: string
}

export interface ComponentRegistryDeps {
  authManager: LiveAuthManager
  stateSignature: StateSignatureManager
  performanceMonitor: PerformanceMonitor
  cluster?: IClusterAdapter
  generateId?: () => string
}

/** Remote singleton proxy — represents a singleton owned by another server instance. */
interface RemoteSingletonEntry {
  componentName: string
  componentId: string
  ownerInstanceId: string
  lastState: Record<string, unknown>
  connections: Map<string, GenericWebSocket>
}


/**
 * Log de erros que antes eram engolidos em silêncio (`catch {}`).
 * Hooks de lifecycle e persistência do cluster não derrubam o fluxo,
 * mas a falha precisa aparecer no log.
 */
function logSwallowed(context: string): (err: unknown) => void {
  return (err: unknown) => {
    const msg = errorMessage(err)
    console.error(`[LiveComponents] ${context} failed: ${msg}`)
  }
}

export class ComponentRegistry {
  private components = new Map<string, AnyLiveComponent>()
  private definitions = new Map<string, ComponentDefinition<Record<string, unknown>>>()
  private metadata = new Map<string, ComponentMetadata>()
  private rooms = new Map<string, Set<string>>()
  private wsConnections = new Map<string, GenericWebSocket>()
  private autoDiscoveredComponents = new Map<string, LiveComponentClass>()
  private healthCheckInterval?: ReturnType<typeof setInterval>
  private singletons = new Map<string, { instance: AnyLiveComponent; connections: Map<string, GenericWebSocket> }>()
  private remoteSingletons = new Map<string, RemoteSingletonEntry>()
  private cluster?: IClusterAdapter

  private authManager: LiveAuthManager
  private stateSignature: StateSignatureManager
  private performanceMonitor: PerformanceMonitor
  private _generateId?: () => string

  /**
   * Renovação throttled do signedState (ver `SignedStateRenewer`). Sem ela a
   * re-hidratação voltava ao snapshot do mount.
   */
  private signatureRenewer: SignedStateRenewer
  /** Por componente: nome usado em `__componentName` e última versão assinada. */
  private signatureMeta = new Map<string, { name: string; version: number }>()

  constructor(deps: ComponentRegistryDeps) {
    this.authManager = deps.authManager
    this.stateSignature = deps.stateSignature
    this.performanceMonitor = deps.performanceMonitor
    this.cluster = deps.cluster
    this._generateId = deps.generateId

    // `renewInterval` pode faltar em mocks de StateSignatureManager -> desligado.
    const renewInterval: unknown = (deps.stateSignature as { renewInterval?: unknown }).renewInterval
    this.signatureRenewer = new SignedStateRenewer({
      intervalMs: typeof renewInterval === 'number' ? renewInterval : 0,
      renew: (componentId) => this.renewSignedState(componentId),
    })

    this.setupHealthMonitoring()
    this.setupClusterHandlers()
  }

  /** Set up handlers for incoming cluster messages (deltas, forwarded actions). */
  private setupClusterHandlers(): void {
    if (!this.cluster) return

    // Handle incoming state deltas from other instances (for remote singletons)
    this.cluster.onDelta((componentId, componentName, delta, sourceInstanceId) => {
      const remote = this.remoteSingletons.get(componentName)
      if (!remote || remote.componentId !== componentId) return

      // Apply delta to local cache
      if (isRecord(delta) && remote.lastState) {
        Object.assign(remote.lastState, delta)
      }

      // Forward STATE_DELTA to all local WebSocket connections interested in this singleton
      const message = JSON.stringify({
        type: 'STATE_DELTA',
        componentId,
        payload: { delta }
      })
      const dead: string[] = []
      for (const [connId, ws] of remote.connections) {
        if (ws.readyState === 1) {
          try { ws.send(message) } catch { dead.push(connId) }
        } else {
          dead.push(connId)
        }
      }
      for (const connId of dead) remote.connections.delete(connId)
    })

    // Handle ownership loss (split-brain detection during heartbeat)
    this.cluster.onOwnershipLost((componentName: string) => {
      const singleton = this.singletons.get(componentName)
      if (!singleton) return

      // Save final state before losing ownership
      this.cluster!.saveSingletonState(componentName, singleton.instance.getSerializableState()).catch(logSwallowed('cluster.saveSingletonState'))

      // Notify all local clients that this singleton is being destroyed
      const errorMsg = JSON.stringify({
        type: 'ERROR',
        componentId: singleton.instance.id,
        payload: { error: 'OWNERSHIP_LOST: singleton moved to another server' }
      })
      for (const [, ws] of singleton.connections) {
        try { ws.send(errorMsg) } catch { /* conexão já fechada */ }
      }

      // Clean up local singleton
      this.cleanupComponent(singleton.instance.id)
      this.singletons.delete(componentName)
    })

    // Handle forwarded actions from other instances (we are the singleton owner)
    this.cluster.onActionForward(async (request: ClusterActionRequest): Promise<ClusterActionResponse> => {
      try {
        // Split-brain protection: verify we still own this singleton before executing
        const stillOwner = await this.cluster!.verifySingletonOwnership(request.componentName)
        if (!stillOwner) {
          return { success: false, error: 'OWNERSHIP_LOST: this instance no longer owns the singleton', requestId: request.requestId }
        }

        // Identidade do usuário que originou a chamada na outra instância.
        // Sem ela, a action seria autorizada como anônima (nunca com o $auth do singleton).
        const callerAuth: LiveAuthContext = request.callerSession
          ? new AuthenticatedContext(request.callerSession)
          : ANONYMOUS_CONTEXT
        const result = await this.executeAction(request.componentId, request.action, request.payload, {
          connectionId: request.callerConnectionId,
          auth: callerAuth,
        })
        return { success: true, result, requestId: request.requestId }
      } catch (error) {
        return { success: false, error: errorMessage(error), requestId: request.requestId }
      }
    })
  }

  private setupHealthMonitoring(): void {
    this.healthCheckInterval = setInterval(() => this.performHealthChecks(), 30000)
  }

  registerComponent<TState extends Record<string, unknown>>(definition: ComponentDefinition<TState>) {
    // O Map guarda definições heterogêneas: o initialState é espalhado junto
    // das props do cliente, então o TState concreto é apagado aqui.
    this.definitions.set(definition.name, definition as unknown as ComponentDefinition<Record<string, unknown>>)
    liveLog('lifecycle', null, `Registered component: ${definition.name}`)
  }

  registerComponentClass(name: string, componentClass: LiveComponentClass) {
    this.autoDiscoveredComponents.set(name, componentClass)
  }

  async autoDiscoverComponents(componentsPath: string) {
    try {
      const fs = await import('fs')
      const path = await import('path')

      if (!fs.existsSync(componentsPath)) return

      const files = fs.readdirSync(componentsPath)

      for (const file of files) {
        if (file.endsWith('.ts') || file.endsWith('.js')) {
          try {
            const fullPath = path.join(componentsPath, file)
            const module: Record<string, unknown> = await import(fullPath)

            Object.keys(module).forEach(exportName => {
              const exportedItem = module[exportName]
              if (this.isLiveComponentClass(exportedItem)) {
                // Prefer static componentName over export name
                const componentName = exportedItem.componentName || exportName.replace(/Component$/, '')
                this.registerComponentClass(componentName, exportedItem)
                liveLog('lifecycle', null, `Auto-discovered component: ${componentName} (from ${file})`)
              }
            })
          } catch {
            // Silent
          }
        }
      }
    } catch (error) {
      console.error('Auto-discovery failed:', error)
    }
  }

  private isLiveComponentClass(cls: unknown): cls is LiveComponentClass {
    if (typeof cls !== 'function' || !cls.prototype) return false
    try {
      // Most reliable: check for static componentName (all LiveComponent subclasses define it)
      if (typeof (cls as { componentName?: unknown }).componentName === 'string') return true

      // Check prototype chain for LiveComponent methods (bundler-safe)
      if (cls.prototype && typeof cls.prototype.executeAction === 'function' &&
          typeof cls.prototype.setState === 'function' &&
          typeof cls.prototype.getSerializableState === 'function') return true

      // Fallback: walk prototype chain checking class name
      // tsup/esbuild may rename LiveComponent to _LiveComponent in bundles
      let prototype: { constructor: { name: string } } | null = cls.prototype
      while (prototype) {
        const name = prototype.constructor.name
        if (name === 'LiveComponent' || name === '_LiveComponent') return true
        prototype = Object.getPrototypeOf(prototype)
      }
      return false
    } catch { return false }
  }

  async mountComponent(
    ws: GenericWebSocket,
    componentName: string,
    props: Record<string, unknown> = {},
    options?: { room?: string; userId?: string; version?: string; debugLabel?: string }
  ): Promise<{ componentId: string; initialState: unknown; signedState: unknown }> {
    const startTime = Date.now()

    try {
      const definition = this.definitions.get(componentName)
      let ComponentClass: LiveComponentClass | null = null
      let initialState: Record<string, unknown> = {}

      if (definition) {
        ComponentClass = definition.component
        initialState = definition.initialState as Record<string, unknown>
      } else {
        ComponentClass = this.autoDiscoveredComponents.get(componentName) ?? null
        if (!ComponentClass) {
          const variations = [
            componentName + 'Component',
            componentName.charAt(0).toUpperCase() + componentName.slice(1) + 'Component',
            componentName.charAt(0).toUpperCase() + componentName.slice(1)
          ]
          for (const variation of variations) {
            ComponentClass = this.autoDiscoveredComponents.get(variation) ?? null
            if (ComponentClass) break
          }
        }
        if (!ComponentClass) throw new Error(`Component '${componentName}' not found`)
        initialState = {}
      }

      // Auth check
      const authContext = ws.data?.authContext || ANONYMOUS_CONTEXT
      const authResult = await this.authManager.authorizeComponent(authContext, ComponentClass.auth)
      if (!authResult.allowed) throw new Error(`AUTH_DENIED: ${authResult.reason}`)

      // Singleton check
      const isSingleton = ComponentClass.singleton === true
      let clusterSingletonId: string | null = null
      if (isSingleton) {
        // Check local singleton first
        const existing = this.singletons.get(componentName)
        if (existing) {
          const connId = ws.data?.connectionId || (this._generateId ? this._generateId() : defaultGenerateId())
          existing.connections.set(connId, ws)
          this.ensureWsData(ws, options?.userId)
          ws.data.components.set(existing.instance.id, existing.instance)

          const currentState = existing.instance.getSerializableState()
          const signedState = this.signComponentState(existing.instance, componentName, currentState)

          sendImmediate(ws, JSON.stringify({
            type: 'STATE_UPDATE',
            componentId: existing.instance.id,
            payload: { state: currentState, signedState },
          }))

          try { internals(existing.instance).onClientJoin(connId, existing.connections.size) } catch (err) { logSwallowed('onClientJoin')(err) }

          return { componentId: existing.instance.id, initialState: currentState, signedState }
        }

        // Check remote singleton (already proxied from another instance)
        const existingRemote = this.remoteSingletons.get(componentName)
        if (existingRemote) {
          const connId = ws.data?.connectionId || (this._generateId ? this._generateId() : defaultGenerateId())
          this.ensureWsData(ws, options?.userId)
          existingRemote.connections.set(connId, ws)

          sendImmediate(ws, JSON.stringify({
            type: 'STATE_UPDATE',
            componentId: existingRemote.componentId,
            payload: { state: existingRemote.lastState }
          }))

          return { componentId: existingRemote.componentId, initialState: existingRemote.lastState, signedState: null }
        }

        // Cluster: try to claim singleton ownership with pre-generated ID (no race window)
        if (this.cluster) {
          clusterSingletonId = this._generateId ? this._generateId() : defaultGenerateId()
          const claim = await this.cluster.claimSingleton(componentName, clusterSingletonId)
          if (!claim.claimed) {
            clusterSingletonId = null
            // Another server owns this singleton — create remote proxy
            const owner = await this.cluster.getSingletonOwner(componentName)
            if (owner) {
              const stored = await this.cluster.loadState(owner.componentId)
              const connId = ws.data?.connectionId || (this._generateId ? this._generateId() : defaultGenerateId())
              this.ensureWsData(ws, options?.userId)

              const remote: RemoteSingletonEntry = {
                componentName,
                componentId: owner.componentId,
                ownerInstanceId: owner.instanceId,
                lastState: isRecord(stored?.state) ? stored.state : {},
                connections: new Map([[connId, ws]])
              }
              this.remoteSingletons.set(componentName, remote)

              sendImmediate(ws, JSON.stringify({
                type: 'STATE_UPDATE',
                componentId: owner.componentId,
                payload: { state: remote.lastState }
              }))

              return { componentId: owner.componentId, initialState: remote.lastState, signedState: null }
            }
          }

          // Failover recovery: recovered state from adapter takes priority over client props
          if (isRecord(claim.recoveredState)) {
            props = { ...props, ...claim.recoveredState }
          }
        }
      }

      // Create component with merged state (props may include recovered cluster state)
      const component = new ComponentClass({ ...initialState, ...props }, ws, options)
      component.setAuthContext(authContext)

      // Cluster singleton: replace auto-generated ID with the one used for the atomic claim
      if (clusterSingletonId) {
        internals(component).id = clusterSingletonId
      }

      component.broadcastToRoom = (message: BroadcastMessage) => {
        this.broadcastToRoom(message, component.id)
      }

      // Metadata
      const metadata = this.createComponentMetadata(component.id, componentName, options?.version)
      this.metadata.set(component.id, metadata)

      this.components.set(component.id, component)
      this.wsConnections.set(component.id, ws)

      if (options?.room) this.subscribeToRoom(component.id, options.room)

      this.ensureWsData(ws, options?.userId)
      ws.data.components.set(component.id, component)

      // Singleton broadcast setup
      if (isSingleton) {
        const connId = ws.data.connectionId || (this._generateId ? this._generateId() : defaultGenerateId())
        const connections = new Map<string, GenericWebSocket>()
        connections.set(connId, ws)
        this.singletons.set(componentName, { instance: component, connections })

        // Cluster: save initial state (claim already established with correct ID)
        if (this.cluster) {
          const singletonState = component.getSerializableState()
          this.cluster.saveState(component.id, componentName, singletonState).catch(logSwallowed('cluster.saveState'))
          this.cluster.saveSingletonState(componentName, singletonState).catch(logSwallowed('cluster.saveSingletonState'))
        }

        internals(component)[EMIT_OVERRIDE_KEY] = (type: string, payload: unknown) => {
          const message: LiveMessage = {
            // emit() aceita qualquer string (tipos custom); o envelope só descreve os conhecidos.
            type: type as LiveMessageType,
            componentId: component.id,
            payload,
            userId: component.userId,
            room: component.room
          }
          const serialized = JSON.stringify(message)
          const singleton = this.singletons.get(componentName)
          if (singleton) {
            const dead: string[] = []
            for (const [cId, cWs] of singleton.connections) {
              try { cWs.send(serialized) } catch { dead.push(cId) }
            }
            for (const cId of dead) singleton.connections.delete(cId)
          }

          // Cluster: publish delta and save state for remote instances
          if (this.cluster && type === 'STATE_DELTA' && isRecord(payload) && payload.delta) {
            const clusterState = component.getSerializableState()
            this.cluster.publishDelta(component.id, componentName, payload.delta).catch(logSwallowed('cluster.publishDelta'))
            this.cluster.saveState(component.id, componentName, clusterState).catch(logSwallowed('cluster.saveState'))
            this.cluster.saveSingletonState(componentName, clusterState).catch(logSwallowed('cluster.saveSingletonState'))
          }
        }

        try { internals(component).onClientJoin(connId, 1) } catch (err) { logSwallowed('onClientJoin')(err) }
      }

      // Metrics & logging
      metadata.state = 'active'
      const renderTime = Date.now() - startTime
      this.recordComponentMetrics(component.id, renderTime)
      registerComponentLogging(component.id, ComponentClass.logging)
      this.performanceMonitor.initializeComponent(component.id, componentName)
      this.performanceMonitor.recordRenderTime(component.id, renderTime)

      // Sign initial state (versão 1) e liga a renovação: deltas posteriores
      // (inclusive os do onMount) geram STATE_SIGNATURE throttled.
      const mountState = component.getSerializableState()
      const signedState = this.signComponentState(component, componentName, mountState, { version: 1 })
      this.installSignatureRenewal(component)

      internals(component).emit('STATE_UPDATE', {
        state: mountState,
        signedState
      })

      // Lifecycle hooks
      try { internals(component).onConnect() } catch (err) { logSwallowed('onConnect')(err) }
      try { await internals(component).onMount() } catch (err) {
        internals(component).emit('ERROR', { action: 'onMount', error: `Mount initialization failed: ${errorMessage(err)}` })
      }

      // Re-read state after onMount (hook may have changed it)
      return { componentId: component.id, initialState: component.getSerializableState(), signedState }
    } catch (error) {
      // Acesso negado é fluxo normal de autorização (ex.: página monta componente
      // protegido antes do login): aviso curto, sem stack. O cliente recebe o erro.
      const message = errorMessage(error)
      if (message.startsWith('AUTH_DENIED')) {
        liveWarn('lifecycle', null, `Mount de ${componentName} negado: ${message}`)
      } else {
        console.error(`Failed to mount component ${componentName}:`, error)
      }
      throw error
    }
  }

  async rehydrateComponent(
    componentId: string,
    componentName: string,
    signedState: SignedState,
    ws: GenericWebSocket,
    options?: LiveComponentConstructorOptions
  ): Promise<{ success: boolean; newComponentId?: string; error?: string }> {
    try {
      const validation = this.stateSignature.validateState(signedState, { skipNonce: true })
      if (!validation.valid) return { success: false, error: validation.error || 'Invalid state signature' }

      const definition = this.definitions.get(componentName)
      let ComponentClass: LiveComponentClass | null = null
      let initialState: Record<string, unknown> = {}

      if (definition) {
        ComponentClass = definition.component
        initialState = definition.initialState as Record<string, unknown>
      } else {
        ComponentClass = this.autoDiscoveredComponents.get(componentName) ?? null
        if (!ComponentClass) {
          const variations = [componentName + 'Component', componentName.charAt(0).toUpperCase() + componentName.slice(1) + 'Component', componentName.charAt(0).toUpperCase() + componentName.slice(1)]
          for (const variation of variations) {
            ComponentClass = this.autoDiscoveredComponents.get(variation) ?? null
            if (ComponentClass) break
          }
        }
        if (!ComponentClass) return { success: false, error: `Component '${componentName}' not found` }
      }

      // Auth check
      const authContext = ws.data?.authContext || ANONYMOUS_CONTEXT
      const authResult = await this.authManager.authorizeComponent(authContext, ComponentClass.auth)
      if (!authResult.allowed) return { success: false, error: `AUTH_DENIED: ${authResult.reason}` }

      const clientState = this.stateSignature.extractData(signedState)

      if (!clientState.__componentName || clientState.__componentName !== componentName) {
        return { success: false, error: 'Component class mismatch - state tampering detected' }
      }

      const { __componentName, ...cleanState } = clientState

      // Singleton: re-hidratar NÃO pode criar uma instância privada — o cliente
      // volta para a instância compartilhada (entra nela se existir; se o server
      // reiniciou e ela não existe, o estado assinado pelo próprio server semeia
      // a nova). O estado atual é enviado pelo mount (STATE_UPDATE).
      if (ComponentClass.singleton === true) {
        const mounted = await this.mountComponent(ws, componentName, cleanState, options)
        return { success: true, newComponentId: mounted.componentId }
      }

      const finalState = definition ? { ...initialState, ...cleanState } : cleanState
      const component = new ComponentClass(finalState, ws, options)
      component.setAuthContext(authContext)

      this.components.set(component.id, component)
      this.wsConnections.set(component.id, ws)
      if (options?.room) this.subscribeToRoom(component.id, options.room)
      this.ensureWsData(ws, options?.userId)
      ws.data.components.set(component.id, component)
      registerComponentLogging(component.id, ComponentClass.logging)

      const rehydratedState = component.getSerializableState()
      const newSignedState = this.signComponentState(component, componentName, rehydratedState, { version: signedState.version + 1 })
      this.installSignatureRenewal(component)

      internals(component).emit('STATE_REHYDRATED', {
        state: rehydratedState,
        signedState: newSignedState,
        oldComponentId: componentId,
        newComponentId: component.id
      })

      try { internals(component).onConnect() } catch (err) { logSwallowed('onConnect')(err) }
      try { internals(component).onRehydrate(clientState) } catch (err) { logSwallowed('onRehydrate')(err) }
      try { await internals(component).onMount() } catch (err) { logSwallowed('onMount')(err) }

      return { success: true, newComponentId: component.id }
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  }

  private ensureWsData(ws: GenericWebSocket, userId?: string): void {
    if (!ws.data) {
      (ws as { data: LiveWSData }).data = {
        connectionId: (this._generateId ? this._generateId() : defaultGenerateId()),
        components: new Map(),
        subscriptions: new Set(),
        connectedAt: new Date(),
        userId
      }
    }
    if (!ws.data.components) ws.data.components = new Map()
  }

  private isSingletonComponent(componentId: string): boolean {
    for (const [, s] of this.singletons) if (s.instance.id === componentId) return true
    return false
  }

  private removeSingletonConnection(componentId: string, connId?: string, context = 'unmount'): boolean {
    // Check local singletons
    for (const [name, singleton] of this.singletons) {
      if (singleton.instance.id !== componentId) continue
      if (connId) singleton.connections.delete(connId)
      if (singleton.connections.size === 0) {
        // Capture final state synchronously BEFORE cleanup destroys the instance
        const finalState = singleton.instance.getSerializableState()
        try { internals(singleton.instance).onDisconnect() } catch (err) { logSwallowed('onDisconnect')(err) }
        this.cleanupComponent(componentId)
        this.singletons.delete(name)
        // Save state to Redis, THEN release claim (must be sequential to avoid race)
        if (this.cluster) {
          this.cluster.saveSingletonState(name, finalState)
            .then(() => this.cluster!.releaseSingleton(name))
            .then(() => this.cluster!.deleteState(componentId))
            .catch(logSwallowed('cluster.release'))
        }
      }
      return true
    }

    // Check remote singletons
    for (const [name, remote] of this.remoteSingletons) {
      if (remote.componentId !== componentId) continue
      if (connId) remote.connections.delete(connId)
      if (remote.connections.size === 0) {
        this.remoteSingletons.delete(name)
      }
      return true
    }

    return false
  }

  unmountComponent(componentId: string, ws?: GenericWebSocket) {
    const component = this.components.get(componentId)
    if (!component) {
      // May be a remote singleton — try to remove the connection
      if (ws) {
        const connId = ws.data?.connectionId
        this.removeSingletonConnection(componentId, connId, 'unmount')
      }
      return
    }

    if (ws) {
      const connId = ws.data?.connectionId
      ws.data?.components?.delete(componentId)

      if (this.isSingletonComponent(componentId)) {
        const singleton = this.singletons.get(this.getSingletonName(componentId) || '')
        const remaining = singleton ? singleton.connections.size - 1 : 0
        try { internals(component).onClientLeave(connId || 'unknown', Math.max(0, remaining)) } catch (err) { logSwallowed('onClientLeave')(err) }
      }

      if (this.removeSingletonConnection(componentId, connId, 'unmount')) return
    } else {
      if (this.removeSingletonConnection(componentId, undefined, 'unmount')) return
    }

    component.destroy?.()
    this.forgetSignedState(componentId)
    this.unsubscribeFromAllRooms(componentId)
    this.components.delete(componentId)
    this.wsConnections.delete(componentId)
    unregisterComponentLogging(componentId)
  }

  private getSingletonName(componentId: string): string | null {
    for (const [name, s] of this.singletons) {
      if (s.instance.id === componentId) return name
    }
    return null
  }

  /** Find a remote singleton entry by componentId. */
  private findRemoteSingleton(componentId: string): RemoteSingletonEntry | null {
    for (const [, entry] of this.remoteSingletons) {
      if (entry.componentId === componentId) return entry
    }
    return null
  }

  /**
   * Executa uma action. `caller` é a identidade de QUEM chamou: a autorização
   * (`static actionAuth`) é avaliada com ela — não com o `$auth` do componente,
   * que num singleton pertence a quem montou primeiro. Sem `caller` (chamada
   * interna/programática) cai no `$auth` do componente.
   */
  async executeAction(componentId: string, action: string, payload: unknown, caller?: ActionCaller): Promise<unknown> {
    const component = this.components.get(componentId)
    if (!component) throw new Error(`COMPONENT_REHYDRATION_REQUIRED:${componentId}`)

    const componentClass = component.constructor as LiveComponentClass
    const actionAuth = componentClass.actionAuth?.[action]

    if (actionAuth) {
      const authContext = caller?.auth || component.$auth || ANONYMOUS_CONTEXT
      const componentName = componentClass.componentName || componentClass.name
      const authResult = await this.authManager.authorizeAction(authContext, componentName, action, actionAuth, undefined, payload)
      if (!authResult.allowed) throw new Error(`AUTH_DENIED: ${authResult.reason}`)
    }

    return await component.executeAction?.(action, payload, caller)
  }

  /**
   * A conexão `ws` montou (ou entrou no singleton) `componentId`?
   * Actions e PROPERTY_UPDATE só são aceitos de quem é dono do componente —
   * ids vazam (ex.: broadcast de sala carrega o componentId do remetente).
   */
  private ownsComponent(ws: GenericWebSocket, componentId: string): boolean {
    if (ws.data?.components?.has(componentId)) return true
    const connId = ws.data?.connectionId
    if (!connId) return false
    const remote = this.findRemoteSingleton(componentId)
    return !!remote && remote.connections.has(connId)
  }

  /** userId confiável: SÓ o que veio da autenticação da conexão (nunca do cliente). */
  private trustedUserId(ws: GenericWebSocket): string | undefined {
    const auth = ws.data?.authContext
    return auth?.authenticated ? auth.session?.id : undefined
  }

  /**
   * Apply a client-driven property update to a mounted component.
   *
   * Security: the property name is attacker-controlled. We MUST restrict
   * which keys the client can write, otherwise a malicious frame like
   *   { type: 'PROPERTY_UPDATE', property: 'session', payload: { value: { roles: ['admin'] } } }
   * would inject arbitrary fields into `this.state`, polluting reads from
   * `this.state.session` in subsequent action handlers (CVE-class issue).
   *
   * Three rules, evaluated in order:
   *   1. Prototype-pollution keys (`__proto__`, `constructor`, `prototype`)
   *      are ALWAYS rejected.
   *   2. `$`-prefixed keys are server-only by convention — the client cannot
   *      write them via PROPERTY_UPDATE. The server can still mutate them
   *      via `this.setState({ $x: ... })` since that bypasses this path.
   *   3. The key must be in EITHER `static updatableFields` (explicit
   *      allowlist, takes precedence) OR `static defaultState` (default).
   */
  updateProperty(componentId: string, property: string, value: unknown) {
    const component = this.components.get(componentId)
    if (!component) throw new Error(`Component '${componentId}' not found`)

    // (1) Prototype-pollution defense — always rejected.
    if (property === '__proto__' || property === 'constructor' || property === 'prototype') {
      throw new Error(`PROPERTY_UPDATE rejected: '${property}' is a reserved key`)
    }

    // (2) `$`-prefix convention — server-only fields.
    if (property.startsWith('$')) {
      throw new Error(
        `PROPERTY_UPDATE rejected: '${property}' is server-only ` +
        `($-prefixed fields cannot be written by the client). ` +
        `Use a server action to mutate it.`
      )
    }

    // (3) Allowlist check.
    const componentClass = component.constructor as LiveComponentClass
    const explicit = componentClass.updatableFields
    const defaults = componentClass.defaultState
      ? Object.keys(componentClass.defaultState)
      : []
    const allowed = explicit ?? defaults

    if (!allowed.includes(property)) {
      throw new Error(
        `PROPERTY_UPDATE rejected: '${property}' is not an updatable field of ` +
        `'${componentClass.componentName || componentClass.name}'. ` +
        `Allowed: [${allowed.join(', ')}]. ` +
        `Declare it in 'static defaultState' or 'static updatableFields' to allow client writes.`
      )
    }

    component.setState?.({ [property]: value })
  }

  subscribeToRoom(componentId: string, roomId: string) {
    if (!this.rooms.has(roomId)) this.rooms.set(roomId, new Set())
    this.rooms.get(roomId)!.add(componentId)
  }

  unsubscribeFromRoom(componentId: string, roomId: string) {
    const room = this.rooms.get(roomId)
    if (room) {
      room.delete(componentId)
      if (room.size === 0) this.rooms.delete(roomId)
    }
  }

  private unsubscribeFromAllRooms(componentId: string) {
    for (const [roomId, components] of Array.from(this.rooms.entries())) {
      if (components.has(componentId)) this.unsubscribeFromRoom(componentId, roomId)
    }
  }

  broadcastToRoom(message: BroadcastMessage, senderComponentId?: string) {
    if (!message.room) return
    const roomComponents = this.rooms.get(message.room)
    if (!roomComponents) return

    const broadcastMessage: LiveMessage = {
      type: 'BROADCAST',
      componentId: senderComponentId || 'system',
      payload: { type: message.type, data: message.payload },
      room: message.room
    }

    // Serialize once, send pre-serialized to all connections
    const serialized = JSON.stringify(broadcastMessage)

    for (const componentId of Array.from(roomComponents)) {
      const component = this.components.get(componentId)
      if (message.excludeUser && component?.userId === message.excludeUser) continue
      const ws = this.wsConnections.get(componentId)
      if (ws) queuePreSerialized(ws, serialized)
    }
  }

  async handleMessage(ws: GenericWebSocket, message: RegistryClientMessage): Promise<{ success: boolean; result?: unknown; error?: string } | null> {
    try {
      switch (message.type) {
        case 'COMPONENT_MOUNT': {
          const mountResult = await this.mountComponent(ws, message.payload.component, message.payload.props, {
            room: message.payload.room,
            // userId enviado pelo cliente é IGNORADO (impersonação). Só auth do server.
            userId: this.trustedUserId(ws),
            debugLabel: message.payload.debugLabel
          })
          return { success: true, result: mountResult }
        }

        case 'COMPONENT_UNMOUNT':
          this.unmountComponent(message.componentId, ws)
          return { success: true }

        case 'CALL_ACTION': {
          // Posse: a mesma resposta de "não existe" para não vazar quais ids existem.
          if (!this.ownsComponent(ws, message.componentId)) {
            throw new Error(`COMPONENT_REHYDRATION_REQUIRED:${message.componentId}`)
          }
          const caller: ActionCaller = {
            connectionId: ws.data?.connectionId,
            auth: ws.data?.authContext || ANONYMOUS_CONTEXT,
          }
          // Check if this action targets a remote singleton (owned by another server)
          const remoteSingleton = this.cluster ? this.findRemoteSingleton(message.componentId) : null
          if (remoteSingleton && this.cluster) {
            const requestId = this._generateId ? this._generateId() : defaultGenerateId()
            const request: ClusterActionRequest = {
              sourceInstanceId: this.cluster.instanceId,
              targetInstanceId: remoteSingleton.ownerInstanceId,
              componentId: remoteSingleton.componentId,
              componentName: remoteSingleton.componentName,
              action: message.action,
              payload: message.payload,
              requestId,
              callerConnectionId: caller.connectionId,
              callerSession: caller.auth.authenticated ? caller.auth.session : undefined,
            }
            const response = await this.cluster.forwardAction(request)
            if (!response.success) throw new Error(response.error || 'Remote action failed')
            if (message.expectResponse) return { success: true, result: response.result }
            return null
          }

          this.recordComponentMetrics(message.componentId, undefined, message.action)
          const actionStart = Date.now()
          try {
            const actionResult = await this.executeAction(message.componentId, message.action, message.payload, caller)
            this.performanceMonitor.recordActionTime(message.componentId, message.action, Date.now() - actionStart)
            if (message.expectResponse) return { success: true, result: actionResult }
            return null
          } catch (error) {
            this.performanceMonitor.recordActionTime(message.componentId, message.action, Date.now() - actionStart, toError(error))
            throw error
          }
        }

        case 'PROPERTY_UPDATE':
          if (!this.ownsComponent(ws, message.componentId)) {
            throw new Error(`COMPONENT_REHYDRATION_REQUIRED:${message.componentId}`)
          }
          this.updateProperty(message.componentId, message.property, message.payload.value)
          return { success: true }

        default:
          return { success: false, error: 'Unknown message type' }
      }
    } catch (error) {
      if (message.componentId) this.recordComponentError(message.componentId, toError(error))
      return { success: false, error: errorMessage(error) }
    }
  }

  cleanupConnection(ws: GenericWebSocket) {
    if (!ws.data?.components) return

    const componentsToCleanup = Array.from(ws.data.components.keys()) as string[]
    const connId = ws.data.connectionId

    for (const componentId of componentsToCleanup) {
      const component = this.components.get(componentId)
      if (component && !this.isSingletonComponent(componentId)) {
        try { internals(component).onDisconnect() } catch (err) { logSwallowed('onDisconnect')(err) }
      }
      if (!this.removeSingletonConnection(componentId, connId || undefined, 'disconnect')) {
        this.cleanupComponent(componentId)
      }
    }

    // Also clean up any remote singleton connections for this ws
    if (connId) {
      for (const [name, remote] of this.remoteSingletons) {
        remote.connections.delete(connId)
        if (remote.connections.size === 0) {
          this.remoteSingletons.delete(name)
        }
      }
    }

    ws.data.components.clear()
  }

  /**
   * Re-send the current signed state of every component mounted on this
   * connection. Used to recover a client whose outgoing queue overflowed
   * (backpressure drop) and is therefore missing one or more STATE_DELTAs —
   * a full STATE_UPDATE snapshot brings it back in sync. Best-effort: skips
   * if the socket is gone, never throws.
   */
  resyncConnection(ws: GenericWebSocket): void {
    if (!ws || ws.readyState !== 1 || !ws.data?.components) return

    for (const componentId of Array.from(ws.data.components.keys()) as string[]) {
      const component = this.components.get(componentId)
      if (!component) continue
      try {
        const componentName =
          this.signatureMeta.get(componentId)?.name ||
          (component.constructor as LiveComponentClass).componentName ||
          this.metadata.get(componentId)?.name ||
          ''
        const currentState = component.getSerializableState()
        const signedState = this.signComponentState(component, componentName, currentState)

        sendImmediate(ws, JSON.stringify({
          type: 'STATE_UPDATE',
          componentId: component.id,
          payload: { state: currentState, signedState },
        }))
      } catch { /* best-effort recovery — never break the send path */ }
    }
  }

  // ===== signedState: assinatura + renovação =====

  /**
   * Assina o estado de `component` para o cliente persistir e re-hidratar.
   * Versão: a informada, ou a última assinada + 1 (monotônica por componente).
   * Registra a assinatura no renewer (abre a janela de throttle).
   */
  private signComponentState(
    component: AnyLiveComponent,
    componentName: string,
    state: object,
    opts: { version?: number; backup?: boolean } = {},
  ): SignedState {
    const previous = this.signatureMeta.get(component.id)
    const version = opts.version ?? (previous ? previous.version + 1 : 1)
    const signedState = this.stateSignature.signState(component.id, {
      ...state,
      __componentName: componentName,
    }, version, { compress: true, backup: opts.backup ?? true })
    this.signatureMeta.set(component.id, { name: componentName, version })
    this.signatureRenewer.markSigned(component.id)
    return signedState
  }

  /** Liga o gancho pós-delta do componente ao renewer (no-op se a renovação estiver desligada). */
  private installSignatureRenewal(component: AnyLiveComponent): void {
    if (!this.signatureRenewer.enabled) return
    const id = component.id
    internals(component)[STATE_DELTA_HOOK_KEY] = () => this.signatureRenewer.notifyDelta(id)
  }

  /**
   * Disparado pelo renewer (fora do caminho do delta): re-assina o estado ATUAL
   * e envia `STATE_SIGNATURE`. Pelo `emit` do componente, então num singleton
   * vai (uma assinatura só) para todas as conexões via EMIT_OVERRIDE.
   * Sem backup: renovações frequentes não devem girar o histórico de backups.
   */
  private renewSignedState(componentId: string): void {
    const component = this.components.get(componentId)
    const meta = this.signatureMeta.get(componentId)
    if (!component || !meta) return
    const signedState = this.signComponentState(component, meta.name, component.getSerializableState(), { backup: false })
    internals(component).emit('STATE_SIGNATURE', { signedState })
  }

  private forgetSignedState(componentId: string): void {
    this.signatureRenewer.forget(componentId)
    this.signatureMeta.delete(componentId)
    this.stateSignature.clearBackups?.(componentId)
  }

  getStats() {
    return {
      components: this.components.size,
      definitions: this.definitions.size,
      rooms: this.rooms.size,
      connections: this.wsConnections.size,
      singletons: Object.fromEntries(
        Array.from(this.singletons.entries()).map(([name, s]) => [name, { componentId: s.instance.id, connections: s.connections.size }])
      ),
      remoteSingletons: Object.fromEntries(
        Array.from(this.remoteSingletons.entries()).map(([name, r]) => [name, { componentId: r.componentId, ownerInstanceId: r.ownerInstanceId, connections: r.connections.size }])
      ),
      roomDetails: Object.fromEntries(
        Array.from(this.rooms.entries()).map(([roomId, components]) => [roomId, components.size])
      )
    }
  }

  getRegisteredComponentNames(): string[] {
    return [...new Set([...this.definitions.keys(), ...this.autoDiscoveredComponents.keys()])]
  }

  getComponent(componentId: string): AnyLiveComponent | undefined {
    return this.components.get(componentId)
  }

  getRoomComponents(roomId: string): AnyLiveComponent[] {
    const componentIds = this.rooms.get(roomId) || new Set<string>()
    const found: AnyLiveComponent[] = []
    for (const id of componentIds) {
      const component = this.components.get(id)
      if (component) found.push(component)
    }
    return found
  }

  private createComponentMetadata(componentId: string, componentName: string, version = '1.0.0'): ComponentMetadata {
    return {
      id: componentId,
      name: componentName,
      version,
      mountedAt: new Date(),
      lastActivity: Date.now(),
      state: 'mounting',
      healthStatus: 'healthy',
      dependencies: [],
      services: new Map(),
      metrics: { renderCount: 0, actionCount: 0, errorCount: 0, averageRenderTime: 0, memoryUsage: 0 },
      migrationHistory: []
    }
  }

  updateComponentActivity(componentId: string): boolean {
    const metadata = this.metadata.get(componentId)
    if (metadata) { metadata.lastActivity = Date.now(); metadata.state = 'active'; return true }
    return false
  }

  recordComponentMetrics(componentId: string, renderTime?: number, action?: string): void {
    const metadata = this.metadata.get(componentId)
    if (!metadata) return
    if (renderTime) {
      metadata.metrics.renderCount++
      metadata.metrics.averageRenderTime = (metadata.metrics.averageRenderTime * (metadata.metrics.renderCount - 1) + renderTime) / metadata.metrics.renderCount
      metadata.metrics.lastRenderTime = renderTime
    }
    if (action) metadata.metrics.actionCount++
    this.updateComponentActivity(componentId)
  }

  recordComponentError(componentId: string, error: Error): void {
    const metadata = this.metadata.get(componentId)
    if (metadata) {
      metadata.metrics.errorCount++
      metadata.healthStatus = metadata.metrics.errorCount > 5 ? 'unhealthy' : 'degraded'
    }
  }

  private performHealthChecks(): void {
    for (const [componentId, metadata] of this.metadata) {
      if (!this.components.get(componentId)) continue
      if (metadata.metrics.errorCount > 10) metadata.healthStatus = 'unhealthy'
      else if (Date.now() - metadata.lastActivity > 300000) metadata.healthStatus = 'degraded'
    }
  }

  private cleanupComponent(componentId: string): void {
    const component = this.components.get(componentId)
    if (component) try { component.destroy?.() } catch (err) { logSwallowed('destroy')(err) }
    this.forgetSignedState(componentId)
    this.performanceMonitor.removeComponent(componentId)
    unregisterComponentLogging(componentId)
    this.components.delete(componentId)
    this.metadata.delete(componentId)
    this.wsConnections.delete(componentId)
    for (const [roomId, componentIds] of this.rooms) {
      componentIds.delete(componentId)
      if (componentIds.size === 0) this.rooms.delete(roomId)
    }
  }

  cleanup(): void {
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval)
    this.signatureRenewer.stop()
    this.singletons.clear()
    this.remoteSingletons.clear()
    for (const [componentId] of this.components) this.cleanupComponent(componentId)
  }
}
