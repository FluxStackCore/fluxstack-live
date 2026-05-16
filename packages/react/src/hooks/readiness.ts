// Readiness helpers used by useLiveComponent (issue #35).
//
// Extracted from the hook so the gate logic and error messages can be
// tested in isolation without spinning up React + a WebSocket.

export type LiveStatus =
  | 'synced'
  | 'disconnected'
  | 'connecting'
  | 'reconnecting'
  | 'loading'
  | 'mounting'
  | 'error'

export interface StatusInputs {
  connected: boolean
  rehydrating: boolean
  loading: boolean
  error: string | null
  componentId: string | null
}

/**
 * Compute the lifecycle status of a Live component.
 *
 * Ordering matters: a disconnected WebSocket is reported as 'connecting'
 * (covers both initial and reconnect phases — the underlying client emits
 * 'reconnecting' separately if it's a reconnect), rehydration takes
 * precedence over loading because the user already had a live component
 * that's being restored, and a non-null componentId is the final gate
 * before declaring 'synced'.
 */
export function computeStatus(s: StatusInputs): LiveStatus {
  if (!s.connected) return 'connecting'
  if (s.rehydrating) return 'reconnecting'
  if (s.loading) return 'loading'
  if (s.error) return 'error'
  if (!s.componentId) return 'mounting'
  return 'synced'
}

/** Convenience: `$ready` boolean exposed on the proxy. */
export function isReady(s: StatusInputs): boolean {
  return computeStatus(s) === 'synced'
}

/**
 * Build a precise "not ready" error for a failed action call.
 *
 * Distinguishes the WS-down case (`connected === false`) from the
 * component-not-mounted case so the developer knows which condition to wait
 * for. Replaces the old generic "Not connected" message from #35.
 */
export function notReadyError(
  action: string,
  componentName: string,
  s: StatusInputs,
): Error {
  const status = computeStatus(s)
  if (!s.connected) {
    return new Error(
      `Cannot call '${action}': WebSocket is not connected (status=${status}). ` +
      `Wait for proxy.$ready before firing actions.`,
    )
  }
  return new Error(
    `Cannot call '${action}': component '${componentName}' is not mounted yet (status=${status}). ` +
    `Wait for proxy.$ready before firing actions.`,
  )
}
