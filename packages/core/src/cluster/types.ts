// @fluxstack/live - Cluster Adapter Types
//
// Interface for cross-instance component synchronization.
// When running multiple server instances, the cluster adapter coordinates:
// - Singleton ownership (only one server runs the instance, others proxy)
// - Component state mirroring (state saved to shared store for rehydration)
// - Action forwarding (proxied singletons forward actions to the owner)
// - State delta broadcasting (owner publishes deltas, proxies relay to local clients)

/**
 * Adapter for cross-instance component synchronization.
 *
 * In single-instance mode, no cluster adapter is needed.
 * For horizontal scaling, provide a RedisClusterAdapter (or custom implementation).
 */
export interface IClusterAdapter {
  /** Unique identifier for this server instance. */
  readonly instanceId: string

  // ── State Mirror ──────────────────────────────────────

  /** Save component state to the shared store. */
  saveState(componentId: string, componentName: string, state: any): Promise<void>

  /** Load component state from the shared store. */
  loadState(componentId: string): Promise<ClusterComponentState | null>

  /** Remove component state from the shared store. */
  deleteState(componentId: string): Promise<void>

  // ── State Delta Pub/Sub ───────────────────────────────

  /** Publish a state delta to all server instances. */
  publishDelta(componentId: string, componentName: string, delta: any): Promise<void>

  /** Register handler for incoming state deltas from other instances. */
  onDelta(handler: ClusterDeltaHandler): void

  // ── Singleton Coordination ────────────────────────────

  /** Attempt to claim ownership of a singleton (atomic). Returns true if claimed. */
  claimSingleton(componentName: string, componentId: string): Promise<boolean>

  /** Get the current owner of a singleton. Returns null if not claimed. */
  getSingletonOwner(componentName: string): Promise<ClusterSingletonOwner | null>

  /** Release ownership of a singleton (when last client disconnects). */
  releaseSingleton(componentName: string): Promise<void>

  /** Verify this instance still owns a singleton (split-brain protection). */
  verifySingletonOwnership(componentName: string): Promise<boolean>

  /** Register callback for when this instance loses ownership of a singleton (detected during heartbeat). */
  onOwnershipLost(handler: (componentName: string) => void): void

  /** Save singleton state keyed by componentName (survives owner crash + claim expiry). */
  saveSingletonState(componentName: string, state: any): Promise<void>

  /** Load the last known singleton state by componentName (for failover recovery). */
  loadSingletonState(componentName: string): Promise<any | null>

  // ── Action Forwarding ─────────────────────────────────

  /** Forward an action to the owner server instance. Returns the action result. */
  forwardAction(request: ClusterActionRequest): Promise<ClusterActionResponse>

  /** Register handler for incoming forwarded actions from other instances. */
  onActionForward(handler: (req: ClusterActionRequest) => Promise<ClusterActionResponse>): void

  // ── Lifecycle ─────────────────────────────────────────

  /** Start the adapter (subscribe to channels, start heartbeats, etc.). */
  start(): Promise<void>

  /** Graceful shutdown (unsubscribe, clear intervals, disconnect). */
  shutdown(): Promise<void>
}

/** State stored in the shared store for a component. */
export interface ClusterComponentState {
  componentName: string
  state: any
  instanceId: string
  updatedAt: number
}

/** Information about the owner of a singleton. */
export interface ClusterSingletonOwner {
  instanceId: string
  componentId: string
}

/** Request to forward an action to another server instance. */
export interface ClusterActionRequest {
  sourceInstanceId: string
  targetInstanceId: string
  componentId: string
  componentName: string
  action: string
  payload: any
  requestId: string
}

/** Response from a forwarded action. */
export interface ClusterActionResponse {
  success: boolean
  result?: any
  error?: string
  requestId: string
}

/** Handler for incoming state deltas from other instances. */
export type ClusterDeltaHandler = (
  componentId: string,
  componentName: string,
  delta: any,
  sourceInstanceId: string
) => void
