// @fluxstack/live - WebSocket Send Batcher
//
// Batches outgoing WebSocket messages per connection using microtask scheduling.
// Instead of N individual ws.send() calls per tick, accumulates messages and
// sends a single JSON array per connection at the end of the synchronous tick.
//
// STATE_DELTA messages for the same componentId are deduplicated (merged).
//
// Pre-serialized messages (from room broadcasts) bypass JSON.stringify entirely.

import type { GenericWebSocket } from './types'
import { MAX_QUEUE_SIZE } from '../protocol/constants'

interface PendingMessage {
  type: string
  componentId: string
  payload: any
  timestamp: number
  userId?: string
  room?: string
  [key: string]: any
}

// A queued item is either an object (needs serialization) or a pre-serialized string
type QueueItem = PendingMessage | string

// Global per-WS message queues
const wsQueues = new WeakMap<GenericWebSocket, QueueItem[]>()
// Track which WS connections have a flush scheduled
const scheduledFlushes = new WeakSet<GenericWebSocket>()
// Set of WS connections that need flushing (use array since WeakSet isn't iterable)
let pendingWs: GenericWebSocket[] = []
let globalFlushScheduled = false

function scheduleWs(ws: GenericWebSocket): void {
  if (!scheduledFlushes.has(ws)) {
    scheduledFlushes.add(ws)
    pendingWs.push(ws)

    if (!globalFlushScheduled) {
      globalFlushScheduled = true
      queueMicrotask(flushAll)
    }
  }
}

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

  // Backpressure: drop oldest messages when queue is full
  if (queue.length >= MAX_QUEUE_SIZE) {
    queue.shift()
  }

  queue.push(message)
  scheduleWs(ws)
}

/**
 * Queue a pre-serialized JSON string to be sent on the next microtask flush.
 * Bypasses JSON.stringify entirely — used for room broadcasts where the same
 * message is sent to many connections.
 */
export function queuePreSerialized(ws: GenericWebSocket, serialized: string): void {
  if (!ws || ws.readyState !== 1) return

  let queue = wsQueues.get(ws)
  if (!queue) {
    queue = []
    wsQueues.set(ws, queue)
  }

  // Backpressure: drop oldest messages when queue is full
  if (queue.length >= MAX_QUEUE_SIZE) {
    queue.shift()
  }

  queue.push(serialized)
  scheduleWs(ws)
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
        const item = queue[0]
        if (typeof item === 'string') {
          // Pre-serialized — send directly
          ws.send(item)
        } else {
          // Single object message — serialize and send
          ws.send(JSON.stringify(item))
        }
      } else {
        // Multiple items — need to build array
        // Separate pre-serialized strings from objects that need dedup
        const objects: PendingMessage[] = []
        const preSerialized: string[] = []

        for (const item of queue) {
          if (typeof item === 'string') {
            preSerialized.push(item)
          } else {
            objects.push(item)
          }
        }

        // Send pre-serialized messages: if only pre-serialized, wrap in array
        // If mixed, we need to combine them
        if (objects.length === 0) {
          // All pre-serialized — build array manually without re-parsing
          ws.send('[' + preSerialized.join(',') + ']')
        } else if (preSerialized.length === 0) {
          // All objects — deduplicate and serialize
          const deduped = deduplicateDeltas(objects)
          ws.send(JSON.stringify(deduped))
        } else {
          // Mixed — serialize objects, build final string directly (no intermediate arrays)
          const deduped = deduplicateDeltas(objects)
          let result = '['
          for (let i = 0; i < deduped.length; i++) {
            if (i > 0) result += ','
            result += JSON.stringify(deduped[i])
          }
          for (const ps of preSerialized) {
            result += ',' + ps
          }
          result += ']'
          ws.send(result)
        }
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
 * Send a binary message immediately (bypass batching).
 * Binary frames are never batched — they are self-framing.
 */
export function sendBinaryImmediate(ws: GenericWebSocket, data: Uint8Array): void {
  if (ws && ws.readyState === 1) {
    ws.send(data)
  }
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
