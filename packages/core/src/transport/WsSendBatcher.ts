// @fluxstack/live - WebSocket Send Batcher
//
// Batches outgoing WebSocket messages per connection using microtask scheduling.
// Instead of N individual ws.send() calls per tick, accumulates messages and
// sends a single JSON array per connection at the end of the synchronous tick.
//
// STATE_DELTA messages for the same componentId are deduplicated (merged).

import type { GenericWebSocket } from './types'

interface PendingMessage {
  type: string
  componentId: string
  payload: any
  timestamp: number
  userId?: string
  room?: string
  [key: string]: any
}

// Global per-WS message queues
const wsQueues = new WeakMap<GenericWebSocket, PendingMessage[]>()
// Track which WS connections have a flush scheduled
const scheduledFlushes = new WeakSet<GenericWebSocket>()
// Set of WS connections that need flushing (use array since WeakSet isn't iterable)
let pendingWs: GenericWebSocket[] = []
let globalFlushScheduled = false

/**
 * Queue a message to be sent on the next microtask flush.
 * Messages are batched per-WS and sent as a JSON array.
 */
export function queueWsMessage(ws: GenericWebSocket, message: PendingMessage): void {
  if (!ws || ws.readyState !== 1) return

  let queue = wsQueues.get(ws)
  if (!queue) {
    queue = []
    wsQueues.set(ws, queue)
  }

  queue.push(message)

  if (!scheduledFlushes.has(ws)) {
    scheduledFlushes.delete(ws) // no-op, just for clarity
    scheduledFlushes.add(ws)
    pendingWs.push(ws)

    if (!globalFlushScheduled) {
      globalFlushScheduled = true
      queueMicrotask(flushAll)
    }
  }
}

/**
 * Flush all pending WS queues. Called once per microtask.
 */
function flushAll(): void {
  globalFlushScheduled = false
  const connections = pendingWs
  pendingWs = []

  for (const ws of connections) {
    scheduledFlushes.delete(ws)
    const queue = wsQueues.get(ws)
    if (!queue || queue.length === 0) continue
    wsQueues.set(ws, [])

    if (ws.readyState !== 1) continue

    try {
      if (queue.length === 1) {
        // Single message — send as plain object (no array wrapper) for backward compat
        ws.send(JSON.stringify(queue[0]))
      } else {
        // Multiple messages — deduplicate STATE_DELTA, then send as array
        const deduped = deduplicateDeltas(queue)
        ws.send(JSON.stringify(deduped))
      }
    } catch {
      // Connection may have closed between queue and flush
    }
  }
}

/**
 * Merge STATE_DELTA messages for the same componentId.
 * Other message types are preserved as-is.
 */
function deduplicateDeltas(messages: PendingMessage[]): PendingMessage[] {
  // Track last STATE_DELTA index per componentId for merging
  const deltaIndices = new Map<string, number>()
  const result: PendingMessage[] = []

  for (const msg of messages) {
    if (msg.type === 'STATE_DELTA' && msg.componentId && msg.payload?.delta) {
      const existing = deltaIndices.get(msg.componentId)
      if (existing !== undefined) {
        // Merge delta into existing message
        const target = result[existing]
        target.payload = {
          delta: { ...target.payload.delta, ...msg.payload.delta }
        }
        target.timestamp = msg.timestamp // use latest timestamp
      } else {
        deltaIndices.set(msg.componentId, result.length)
        // Clone to avoid mutating original
        result.push({ ...msg, payload: { delta: { ...msg.payload.delta } } })
      }
    } else {
      result.push(msg)
    }
  }

  return result
}

/**
 * Send a message immediately (bypass batching).
 * Used for ACTION_RESPONSE and other request-response patterns
 * where the client is awaiting an immediate response.
 */
export function sendImmediate(ws: GenericWebSocket, data: string): void {
  if (ws && ws.readyState === 1) {
    ws.send(data)
  }
}
