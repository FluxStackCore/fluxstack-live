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
      // Multiple items — single-pass partition while counting both sides.
      // The previous code did one partition pass, then up to two more
      // iterations during serialization. We collapse to one pass and one
      // serialize loop, building the output via Array.join (V8-optimised)
      // instead of string concatenation (`result += ...`).
      let firstObjIdx = -1
      let preSerCount = 0
      for (let i = 0; i < queue.length; i++) {
        if (typeof queue[i] === 'string') {
          preSerCount++
        } else if (firstObjIdx === -1) {
          firstObjIdx = i
        }
      }

      if (firstObjIdx === -1) {
        // All pre-serialized — build array manually without re-parsing.
        // queue is already a string[], so join() is the cheapest path.
        ws.send('[' + (queue as string[]).join(',') + ']')
      } else if (preSerCount === 0) {
        // All objects — deduplicate and serialize in one shot.
        const deduped = deduplicateDeltas(queue as PendingMessage[])
        ws.send(JSON.stringify(deduped))
      } else {
        // Mixed — partition once, serialize each side, join via Array.
        // Using Array.join scales better than `result += JSON.stringify(...)`
        // because V8 internally builds a rope/cons-string for the latter
        // and flattens later, which is O(N) per concat in the worst case.
        const objects: PendingMessage[] = []
        const preSerialized: string[] = []
        for (const item of queue) {
          if (typeof item === 'string') preSerialized.push(item)
          else objects.push(item)
        }
        const deduped = deduplicateDeltas(objects)
        const parts = new Array<string>(deduped.length + preSerialized.length)
        for (let i = 0; i < deduped.length; i++) parts[i] = JSON.stringify(deduped[i])
        for (let i = 0; i < preSerialized.length; i++) parts[deduped.length + i] = preSerialized[i]!
        ws.send('[' + parts.join(',') + ']')
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

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    && Object.getPrototypeOf(v) === Object.prototype
}

/**
 * Deep-merge two delta objects. Plain objects are merged recursively;
 * all other values (primitives, arrays, class instances) use last-write-wins.
 *
 * Fixes #22: the previous shallow spread `{ ...a, ...b }` would overwrite an
 * entire nested object (e.g. `players`) when both deltas touched the same key,
 * silently dropping updates from the first delta.
 */
function mergeDeltas(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...a }
  for (const key of Object.keys(b)) {
    result[key] = isPlainObject(a[key]) && isPlainObject(b[key])
      ? mergeDeltas(a[key], b[key])
      : b[key]
  }
  return result
}

/**
 * Merge STATE_DELTA messages for the same componentId.
 * Other message types are preserved as-is.
 *
 * Fast path (the common case): if no componentId appears twice in the batch,
 * we return the input array unchanged — zero allocation. Only when a
 * conflict is detected do we clone the conflicting message and switch to
 * the slow path that materialises a new array. This matters because every
 * fanned-out STATE_DELTA broadcast hits this function once per recipient.
 */
function deduplicateDeltas(messages: PendingMessage[]): PendingMessage[] {
  // Fast path: scan once to detect duplicates. If none, return input as-is.
  const firstSeen = new Map<string, number>()
  let firstDupIdx = -1
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    if (msg.type === 'STATE_DELTA' && msg.componentId && msg.payload?.delta) {
      if (firstSeen.has(msg.componentId)) {
        firstDupIdx = i
        break
      }
      firstSeen.set(msg.componentId, i)
    }
  }
  if (firstDupIdx === -1) return messages

  // Slow path: at least one duplicate exists. Build a deduplicated array
  // starting from the conflict point — earlier entries are kept as-is.
  const deltaIndices = new Map<string, number>()
  const result: PendingMessage[] = new Array(firstDupIdx)
  for (let i = 0; i < firstDupIdx; i++) {
    const m = messages[i]!
    result[i] = m
    if (m.type === 'STATE_DELTA' && m.componentId && m.payload?.delta) {
      deltaIndices.set(m.componentId, i)
    }
  }
  for (let i = firstDupIdx; i < messages.length; i++) {
    const msg = messages[i]!
    if (msg.type === 'STATE_DELTA' && msg.componentId && msg.payload?.delta) {
      const existing = deltaIndices.get(msg.componentId)
      if (existing !== undefined) {
        // Deep-merge into existing message. We clone the target lazily here
        // (once per dedup site) so the original input is never mutated.
        const target = result[existing]!
        const cloned: PendingMessage = {
          ...target,
          payload: { delta: mergeDeltas(target.payload.delta, msg.payload.delta) },
          timestamp: msg.timestamp,
        }
        result[existing] = cloned
      } else {
        deltaIndices.set(msg.componentId, result.length)
        result.push(msg)
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
