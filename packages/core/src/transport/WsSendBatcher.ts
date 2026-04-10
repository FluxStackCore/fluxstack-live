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
import { liveWarn } from '../debug/LiveLogger'

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

// ===== Telemetry (fixes #7) =====
//
// Before this was added, the batcher silently dropped messages in three
// places: backpressure (queue full), ws closed between queue and flush,
// and serialization errors inside flushAll. Now every drop increments a
// counter and (for backpressure) emits a one-shot warning per connection
// so operators notice churn.

interface BatcherStats {
  /** Messages dropped because the per-connection queue reached MAX_QUEUE_SIZE. */
  droppedBackpressure: number
  /** Messages dropped because the WebSocket was closed at flush time. */
  droppedClosed: number
  /** Messages dropped because JSON.stringify / ws.send threw during flush. */
  droppedSerializationError: number
}

const stats: BatcherStats = {
  droppedBackpressure: 0,
  droppedClosed: 0,
  droppedSerializationError: 0,
}

/** Connections that have already been warned about backpressure (one-shot). */
const backpressureWarned = new WeakSet<GenericWebSocket>()

/** Read a snapshot of the batcher's drop counters. */
export function getBatcherStats(): Readonly<BatcherStats> {
  return { ...stats }
}

/** Reset counters (test-only). */
export function resetBatcherStats(): void {
  stats.droppedBackpressure = 0
  stats.droppedClosed = 0
  stats.droppedSerializationError = 0
}

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
 * Record a backpressure drop and warn once per connection.
 * Fixes #7 H7: previously the batcher silently `shift()`-ed the oldest
 * message with no telemetry, so bursty producers caused state drift on
 * the client with no visible signal.
 */
function recordBackpressureDrop(ws: GenericWebSocket): void {
  stats.droppedBackpressure++
  if (!backpressureWarned.has(ws)) {
    backpressureWarned.add(ws)
    liveWarn('websocket', null,
      `WsSendBatcher backpressure on connection: per-WS queue reached ${MAX_QUEUE_SIZE} messages. ` +
      `Oldest messages are being dropped. This warning is one-shot per connection; ` +
      `check server.getBatcherStats() for running totals.`)
  }
}

/**
 * Queue a message to be sent on the next microtask flush.
 * Messages are batched per-WS and sent as a JSON array.
 */
export function queueWsMessage(ws: GenericWebSocket, message: PendingMessage): void {
  if (!ws || ws.readyState !== 1) {
    // Fixes #7 H5/H6: previously this was a silent drop. Count it.
    if (ws) stats.droppedClosed++
    return
  }

  let queue = wsQueues.get(ws)
  if (!queue) {
    queue = []
    wsQueues.set(ws, queue)
  }

  // Backpressure: drop oldest messages when queue is full
  if (queue.length >= MAX_QUEUE_SIZE) {
    queue.shift()
    recordBackpressureDrop(ws)
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
  if (!ws || ws.readyState !== 1) {
    if (ws) stats.droppedClosed++
    return
  }

  let queue = wsQueues.get(ws)
  if (!queue) {
    queue = []
    wsQueues.set(ws, queue)
  }

  // Backpressure: drop oldest messages when queue is full
  if (queue.length >= MAX_QUEUE_SIZE) {
    queue.shift()
    recordBackpressureDrop(ws)
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
    flushOne(ws)
  }
}

/**
 * Flush a single WS's queue synchronously.
 *
 * Exposed so `sendBinaryImmediate` can drain any batched messages BEFORE
 * writing the binary frame — otherwise the binary frame would overtake
 * pending JSON state updates on the wire (fixes #7 H8).
 */
function flushOne(ws: GenericWebSocket): void {
  scheduledFlushes.delete(ws)
  const queue = wsQueues.get(ws)
  if (!queue || queue.length === 0) return
  wsQueues.set(ws, [])

  if (ws.readyState !== 1) {
    // Fixes #7 H5: previously the messages were silently discarded when
    // the connection was closed between queue and flush. Count them.
    stats.droppedClosed += queue.length
    return
  }

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
  } catch (err: any) {
    // Fixes #7 H4: previously this catch was empty, so circular refs,
    // BigInt, getter throws, and post-close ws.send failures were all
    // swallowed with zero telemetry. Count and log so the cause is visible.
    stats.droppedSerializationError += queue.length
    liveWarn('websocket', null,
      `WsSendBatcher flush failed (${queue.length} message${queue.length === 1 ? '' : 's'} dropped): ${err?.message || err}`)
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
 *
 * Fixes #7 H8: before this fix, `queueWsMessage(A); sendBinaryImmediate(B);`
 * sent B before A because queued messages waited for the next microtask
 * while binary writes happened synchronously. That lets a binary state
 * delta overtake the JSON STATE_UPDATE that establishes the keys it
 * references, producing garbage on the client. We now flush the per-WS
 * queue inline before sending the binary frame so ordering matches the
 * caller's intuition.
 */
export function sendBinaryImmediate(ws: GenericWebSocket, data: Uint8Array): void {
  if (!ws) return
  if (ws.readyState !== 1) {
    stats.droppedClosed++
    return
  }
  // Drain any pending batched messages first so they land on the wire
  // before this binary frame. This preserves caller ordering.
  flushOne(ws)
  try {
    ws.send(data)
  } catch (err: any) {
    stats.droppedSerializationError++
    liveWarn('websocket', null, `WsSendBatcher sendBinaryImmediate failed: ${err?.message || err}`)
  }
}

/**
 * Send a message immediately (bypass batching).
 * Used for ACTION_RESPONSE and other request-response patterns
 * where the client is awaiting an immediate response.
 *
 * Like `sendBinaryImmediate`, this flushes any pending batched messages
 * first so ordering is preserved.
 */
export function sendImmediate(ws: GenericWebSocket, data: string): void {
  if (!ws) return
  if (ws.readyState !== 1) {
    stats.droppedClosed++
    return
  }
  flushOne(ws)
  try {
    ws.send(data)
  } catch (err: any) {
    stats.droppedSerializationError++
    liveWarn('websocket', null, `WsSendBatcher sendImmediate failed: ${err?.message || err}`)
  }
}
