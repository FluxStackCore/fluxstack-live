// @fluxstack/live - Component Registry
//
// Enhanced component registry with lifecycle management, health monitoring,
// state signing, singleton support, and auto-discovery.

import type { LiveComponent } from './LiveComponent'
import { EMIT_OVERRIDE_KEY } from './LiveComponent'
import type { GenericWebSocket, LiveWSData } from '../transport/types'
import { queueWsMessage, sendImmediate } from '../transport/WsSendBatcher'
import type { LiveMessage, BroadcastMessage, ComponentDefinition } from '../protocol/messages'
import type { LiveComponentAuth, LiveActionAuthMap } from '../auth/types'
import { ANONYMOUS_CONTEXT } from '../auth/LiveAuthContext'
import type { LiveAuthManager } from '../auth/LiveAuthManager'
import type { StateSignatureManager, SignedState } from '../security/StateSignature'
import type { PerformanceMonitor } from '../monitoring/PerformanceMonitor'
import { liveLog, registerComponentLogging, unregisterComponentLogging } from '../debug/LiveLogger'
import type { IClusterAdapter, ClusterActionRequest, ClusterActionResponse } from '../cluster/types'

export interface ComponentMetadata {
  id: string
  name: string
  version: string
  mountedAt: Date
  lastActivity: Date
  state: 'mounting' | 'active' | 'inactive' | 'error' | 'destroying'
  healthStatus: 'healthy' | 'degraded' | 'unhealthy'
  dependencies: string[]
  services: Map<string, any>
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
}

/** Remote singleton proxy — represents a singleton owned by another server instance. */
interface RemoteSingletonEntry {
  componentName: string
  componentId: string
  ownerInstanceId: string
  lastState: any
  connections: Map<string, GenericWebSocket>
}

export class ComponentRegistry {
  private components = new Map<string, LiveComponent>()
  private definitions = new Map<string, ComponentDefinition<any>>()
  private metadata = new Map<string, ComponentMetadata>()
  private rooms = new Map<string, Set<string>>()
  private wsConnections = new Map<string, GenericWebSocket>()
  private autoDiscoveredComponents = new Map<string, new (initialState: any, ws: GenericWebSocket, options?: { room?: string; userId?: string }) => LiveComponent<any>>()
  private healthCheckInterval?: ReturnType<typeof setInterval>
  private singletons = new Map<string, { instance: LiveComponent; connections: Map<string, GenericWebSocket> }>()
  private remoteSingletons = new Map<string, RemoteSingletonEntry>()
  private cluster?: IClusterAdapter

  private authManager: LiveAuthManager
  private stateSignature: StateSignatureManager
  private performanceMonitor: PerformanceMonitor

  constructor(deps: ComponentRegistryDeps) {
    this.authManager = deps.authManager
    this.stateSignature = deps.stateSignature
    this.performanceMonitor = deps.performanceMonitor
    this.cluster = deps.cluster

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
      if (delta && remote.lastState) {
        Object.assign(remote.lastState, delta)
      }

      // Forward STATE_DELTA to all local WebSocket connections interested in this singleton
      const message = JSON.stringify({
        type: 'STATE_DELTA',
        componentId,
        payload: { delta },
        timestamp: Date.now()
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
      this.cluster!.saveSingletonState(componentName, singleton.instance.getSerializableState()).catch(() => {})

      // Notify all local clients that this singleton is being destroyed
      const errorMsg = JSON.stringify({
        type: 'ERROR',
        componentId: singleton.instance.id,
        payload: { error: 'OWNERSHIP_LOST: singleton moved to another server' },
        timestamp: Date.now()
      })
      for (const [, ws] of singleton.connections) {
        try { ws.send(errorMsg) } catch { /* ignore */ }
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

        const result = await this.executeAction(request.componentId, request.action, request.payload)
        return { success: true, result, requestId: request.requestId }
      } catch (error: any) {
        return { success: false, error: error.message, requestId: request.requestId }
      }
    })
  }

  private setupHealthMonitoring(): void {
    this.healthCheckInterval = setInterval(() => this.performHealthChecks(), 30000)
  }

  registerComponent<TState>(definition: ComponentDefinition<TState>) {
    this.definitions.set(definition.name, definition)
    liveLog('lifecycle', null, `Registered component: ${definition.name}`)
  }

  registerComponentClass(name: string, componentClass: new (initialState: any, ws: GenericWebSocket, options?: { room?: string; userId?: string }) => LiveComponent<any>) {
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
            const module = await import(fullPath)

            Object.keys(module).forEach(exportName => {
              const exportedItem = module[exportName]
              if (typeof exportedItem === 'function' &&
                  exportedItem.prototype &&
                  this.isLiveComponentClass(exportedItem)) {
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

  private isLiveComponentClass(cls: any): boolean {
    try {
      // Most reliable: check for static componentName (all LiveComponent subclasses define it)
      if (typeof cls.componentName === 'string') return true

      // Check prototype chain for LiveComponent methods (bundler-safe)
      if (cls.prototype && typeof cls.prototype.executeAction === 'function' &&
          typeof cls.prototype.setState === 'function' &&
          typeof cls.prototype.getSerializableState === 'function') return true

      // Fallback: walk prototype chain checking class name
      // tsup/esbuild may rename LiveComponent to _LiveComponent in bundles
      let prototype = cls.prototype
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
      let ComponentClass: (new (initialState: any, ws: GenericWebSocket, options?: { room?: string; userId?: string }) => LiveComponent<any>) | null = null
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
      const componentAuth = (ComponentClass as any).auth as LiveComponentAuth | undefined
      const authResult = await this.authManager.authorizeComponent(authContext, componentAuth)
      if (!authResult.allowed) throw new Error(`AUTH_DENIED: ${authResult.reason}`)

      // Singleton check
      const isSingleton = (ComponentClass as any).singleton === true
      let clusterSingletonId: string | null = null
      if (isSingleton) {
        // Check local singleton first
        const existing = this.singletons.get(componentName)
        if (existing) {
          const connId = ws.data?.connectionId || `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          existing.connections.set(connId, ws)
          this.ensureWsData(ws, options?.userId)
          ws.data.components.set(existing.instance.id, existing.instance)

          const signedState = this.stateSignature.signState(existing.instance.id, {
            ...existing.instance.getSerializableState(),
            __componentName: componentName
          }, 1, { compress: true, backup: true })

          sendImmediate(ws, JSON.stringify({
            type: 'STATE_UPDATE',
            componentId: existing.instance.id,
            payload: { state: existing.instance.getSerializableState(), signedState },
            timestamp: Date.now()
          }))

          try { (existing.instance as any).onClientJoin(connId, existing.connections.size) } catch { /* ignore */ }

          return { componentId: existing.instance.id, initialState: existing.instance.getSerializableState(), signedState }
        }

        // Check remote singleton (already proxied from another instance)
        const existingRemote = this.remoteSingletons.get(componentName)
        if (existingRemote) {
          const connId = ws.data?.connectionId || `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          this.ensureWsData(ws, options?.userId)
          existingRemote.connections.set(connId, ws)

          sendImmediate(ws, JSON.stringify({
            type: 'STATE_UPDATE',
            componentId: existingRemote.componentId,
            payload: { state: existingRemote.lastState },
            timestamp: Date.now()
          }))

          return { componentId: existingRemote.componentId, initialState: existingRemote.lastState, signedState: null }
        }

        // Cluster: try to claim singleton ownership with pre-generated ID (no race window)
        if (this.cluster) {
          clusterSingletonId = `live-${crypto.randomUUID()}`
          const claim = await this.cluster.claimSingleton(componentName, clusterSingletonId)
          if (!claim.claimed) {
            clusterSingletonId = null
            // Another server owns this singleton — create remote proxy
            const owner = await this.cluster.getSingletonOwner(componentName)
            if (owner) {
              const stored = await this.cluster.loadState(owner.componentId)
              const connId = ws.data?.connectionId || `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
              this.ensureWsData(ws, options?.userId)

              const remote: RemoteSingletonEntry = {
                componentName,
                componentId: owner.componentId,
                ownerInstanceId: owner.instanceId,
                lastState: stored?.state || {},
                connections: new Map([[connId, ws]])
              }
              this.remoteSingletons.set(componentName, remote)

              sendImmediate(ws, JSON.stringify({
                type: 'STATE_UPDATE',
                componentId: owner.componentId,
                payload: { state: remote.lastState },
                timestamp: Date.now()
              }))

              return { componentId: owner.componentId, initialState: remote.lastState, signedState: null }
            }
          }

          // Failover recovery: recovered state from adapter takes priority over client props
          if (claim.recoveredState) {
            props = { ...props, ...claim.recoveredState }
          }
        }
      }

      // Create component with merged state (props may include recovered cluster state)
      const component = new ComponentClass({ ...initialState, ...props }, ws, options)
      component.setAuthContext(authContext)

      // Cluster singleton: replace auto-generated ID with the one used for the atomic claim
      if (clusterSingletonId) {
        ;(component as any).id = clusterSingletonId
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
        const connId = ws.data.connectionId || `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const connections = new Map<string, GenericWebSocket>()
        connections.set(connId, ws)
        this.singletons.set(componentName, { instance: component, connections })

        // Cluster: save initial state (claim already established with correct ID)
        if (this.cluster) {
          this.cluster.saveState(component.id, componentName, component.getSerializableState()).catch(() => {})
          this.cluster.saveSingletonState(componentName, component.getSerializableState()).catch(() => {})
        }

        ;(component as any)[EMIT_OVERRIDE_KEY] = (type: string, payload: any) => {
          const message: LiveMessage = {
            type: type as any,
            componentId: component.id,
            payload,
            timestamp: Date.now(),
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
          if (this.cluster && type === 'STATE_DELTA' && payload?.delta) {
            this.cluster.publishDelta(component.id, componentName, payload.delta).catch(() => {})
            this.cluster.saveState(component.id, componentName, component.getSerializableState()).catch(() => {})
            this.cluster.saveSingletonState(componentName, component.getSerializableState()).catch(() => {})
          }
        }

        try { (component as any).onClientJoin(connId, 1) } catch { /* ignore */ }
      }

      // Metrics & logging
      metadata.state = 'active'
      const renderTime = Date.now() - startTime
      this.recordComponentMetrics(component.id, renderTime)
      registerComponentLogging(component.id, (ComponentClass as any).logging)
      this.performanceMonitor.initializeComponent(component.id, componentName)
      this.performanceMonitor.recordRenderTime(component.id, renderTime)

      // Sign initial state
      const signedState = this.stateSignature.signState(component.id, {
        ...component.getSerializableState(),
        __componentName: componentName
      }, 1, { compress: true, backup: true })

      ;(component as any).emit('STATE_UPDATE', {
        state: component.getSerializableState(),
        signedState
      })

      // Lifecycle hooks
      try { (component as any).onConnect() } catch { /* ignore */ }
      try { await (component as any).onMount() } catch (err: any) {
        ;(component as any).emit('ERROR', { action: 'onMount', error: `Mount initialization failed: ${err?.message || err}` })
      }

      return { componentId: component.id, initialState: component.getSerializableState(), signedState }
    } catch (error: any) {
      console.error(`Failed to mount component ${componentName}:`, error)
      throw error
    }
  }

  async rehydrateComponent(
    componentId: string,
    componentName: string,
    signedState: SignedState,
    ws: GenericWebSocket,
    options?: { room?: string; userId?: string }
  ): Promise<{ success: boolean; newComponentId?: string; error?: string }> {
    try {
      const validation = this.stateSignature.validateState(signedState, { skipNonce: true })
      if (!validation.valid) return { success: false, error: validation.error || 'Invalid state signature' }

      const definition = this.definitions.get(componentName)
      let ComponentClass: (new (initialState: any, ws: GenericWebSocket, options?: { room?: string; userId?: string }) => LiveComponent<any>) | null = null
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
      const componentAuth = (ComponentClass as any).auth as LiveComponentAuth | undefined
      const authResult = await this.authManager.authorizeComponent(authContext, componentAuth)
      if (!authResult.allowed) return { success: false, error: `AUTH_DENIED: ${authResult.reason}` }

      const clientState = this.stateSignature.extractData(signedState) as Record<string, any>

      if (!clientState.__componentName || clientState.__componentName !== componentName) {
        return { success: false, error: 'Component class mismatch - state tampering detected' }
      }

      const { __componentName, ...cleanState } = clientState
      const finalState = definition ? { ...initialState, ...cleanState } : cleanState
      const component = new ComponentClass(finalState, ws, options)
      component.setAuthContext(authContext)

      this.components.set(component.id, component)
      this.wsConnections.set(component.id, ws)
      if (options?.room) this.subscribeToRoom(component.id, options.room)
      this.ensureWsData(ws, options?.userId)
      ws.data.components.set(component.id, component)
      registerComponentLogging(component.id, (ComponentClass as any).logging)

      const newSignedState = this.stateSignature.signState(
        component.id,
        { ...component.getSerializableState(), __componentName: componentName },
        signedState.version + 1
      )

      ;(component as any).emit('STATE_REHYDRATED', {
        state: component.getSerializableState(),
        signedState: newSignedState,
        oldComponentId: componentId,
        newComponentId: component.id
      })

      try { (component as any).onConnect() } catch { /* ignore */ }
      try { (component as any).onRehydrate(clientState) } catch { /* ignore */ }
      try { await (component as any).onMount() } catch { /* ignore */ }

      return { success: true, newComponentId: component.id }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  }

  private ensureWsData(ws: GenericWebSocket, userId?: string): void {
    if (!ws.data) {
      (ws as { data: LiveWSData }).data = {
        connectionId: `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
        try { (singleton.instance as any).onDisconnect() } catch { /* ignore */ }
        this.cleanupComponent(componentId)
        this.singletons.delete(name)
        // Save state to Redis, THEN release claim (must be sequential to avoid race)
        if (this.cluster) {
          this.cluster.saveSingletonState(name, finalState)
            .then(() => this.cluster!.releaseSingleton(name))
            .then(() => this.cluster!.deleteState(componentId))
            .catch(() => {})
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
        try { (component as any).onClientLeave(connId || 'unknown', Math.max(0, remaining)) } catch { /* ignore */ }
      }

      if (this.removeSingletonConnection(componentId, connId, 'unmount')) return
    } else {
      if (this.removeSingletonConnection(componentId, undefined, 'unmount')) return
    }

    component.destroy?.()
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

  async executeAction(componentId: string, action: string, payload: any): Promise<any> {
    const component = this.components.get(componentId)
    if (!component) throw new Error(`COMPONENT_REHYDRATION_REQUIRED:${componentId}`)

    const componentClass = component.constructor as any
    const actionAuthMap = componentClass.actionAuth as LiveActionAuthMap | undefined
    const actionAuth = actionAuthMap?.[action]

    if (actionAuth) {
      const authContext = (component as any).$auth || ANONYMOUS_CONTEXT
      const componentName = componentClass.componentName || componentClass.name
      const authResult = await this.authManager.authorizeAction(authContext, componentName, action, actionAuth, undefined, payload)
      if (!authResult.allowed) throw new Error(`AUTH_DENIED: ${authResult.reason}`)
    }

    return await component.executeAction?.(action, payload)
  }

  updateProperty(componentId: string, property: string, value: any) {
    const component = this.components.get(componentId)
    if (!component) throw new Error(`Component '${componentId}' not found`)
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
      timestamp: Date.now(),
      room: message.room
    }

    for (const componentId of Array.from(roomComponents)) {
      const component = this.components.get(componentId)
      if (message.excludeUser && component?.userId === message.excludeUser) continue
      const ws = this.wsConnections.get(componentId)
      if (ws) queueWsMessage(ws, broadcastMessage as any)
    }
  }

  async handleMessage(ws: GenericWebSocket, message: LiveMessage): Promise<{ success: boolean; result?: unknown; error?: string } | null> {
    try {
      if (message.componentId) this.updateComponentActivity(message.componentId)

      switch (message.type) {
        case 'COMPONENT_MOUNT':
          const mountResult = await this.mountComponent(ws, message.payload.component, message.payload.props, {
            room: message.payload.room,
            userId: message.userId,
            debugLabel: message.payload.debugLabel
          })
          return { success: true, result: mountResult }

        case 'COMPONENT_UNMOUNT':
          this.unmountComponent(message.componentId, ws)
          return { success: true }

        case 'CALL_ACTION': {
          // Check if this action targets a remote singleton (owned by another server)
          const remoteSingleton = this.findRemoteSingleton(message.componentId)
          if (remoteSingleton && this.cluster) {
            const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
            const request: ClusterActionRequest = {
              sourceInstanceId: this.cluster.instanceId,
              targetInstanceId: remoteSingleton.ownerInstanceId,
              componentId: remoteSingleton.componentId,
              componentName: remoteSingleton.componentName,
              action: message.action!,
              payload: message.payload,
              requestId
            }
            const response = await this.cluster.forwardAction(request)
            if (!response.success) throw new Error(response.error || 'Remote action failed')
            if (message.expectResponse) return { success: true, result: response.result }
            return null
          }

          this.recordComponentMetrics(message.componentId, undefined, message.action)
          const actionStart = Date.now()
          try {
            const actionResult = await this.executeAction(message.componentId, message.action!, message.payload)
            this.performanceMonitor.recordActionTime(message.componentId, message.action!, Date.now() - actionStart)
            if (message.expectResponse) return { success: true, result: actionResult }
            return null
          } catch (error: any) {
            this.performanceMonitor.recordActionTime(message.componentId, message.action!, Date.now() - actionStart, error)
            throw error
          }
        }

        case 'PROPERTY_UPDATE':
          this.updateProperty(message.componentId, message.property!, message.payload.value)
          return { success: true }

        default:
          return { success: false, error: 'Unknown message type' }
      }
    } catch (error: any) {
      if (message.componentId) this.recordComponentError(message.componentId, error)
      return { success: false, error: error.message }
    }
  }

  cleanupConnection(ws: GenericWebSocket) {
    if (!ws.data?.components) return

    const componentsToCleanup = Array.from(ws.data.components.keys()) as string[]
    const connId = ws.data.connectionId

    for (const componentId of componentsToCleanup) {
      const component = this.components.get(componentId)
      if (component && !this.isSingletonComponent(componentId)) {
        try { (component as any).onDisconnect() } catch { /* ignore */ }
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

  getComponent(componentId: string): LiveComponent | undefined {
    return this.components.get(componentId)
  }

  getRoomComponents(roomId: string): LiveComponent[] {
    const componentIds = this.rooms.get(roomId) || new Set()
    return Array.from(componentIds).map(id => this.components.get(id)).filter(Boolean) as LiveComponent[]
  }

  private createComponentMetadata(componentId: string, componentName: string, version = '1.0.0'): ComponentMetadata {
    return {
      id: componentId,
      name: componentName,
      version,
      mountedAt: new Date(),
      lastActivity: new Date(),
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
    if (metadata) { metadata.lastActivity = new Date(); metadata.state = 'active'; return true }
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
      else if (Date.now() - metadata.lastActivity.getTime() > 300000) metadata.healthStatus = 'degraded'
    }
  }

  private cleanupComponent(componentId: string): void {
    const component = this.components.get(componentId)
    if (component) try { component.destroy?.() } catch { /* ignore */ }
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
    this.singletons.clear()
    this.remoteSingletons.clear()
    for (const [componentId] of this.components) this.cleanupComponent(componentId)
  }
}
