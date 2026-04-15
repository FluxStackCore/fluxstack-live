// @fluxstack/live-cli — Message formatting

import { C, color, colorForType } from './colors.js'

export interface FormatOptions {
  raw?: boolean
  quiet?: boolean
  filter?: string
}

/** Collect leaf paths from a nested object for delta display */
export function collectLeafPaths(obj: any, prefix = '', out: [string, any][] = []): [string, any][] {
  if (obj === null || typeof obj !== 'object') {
    out.push([prefix, obj])
    return out
  }
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      collectLeafPaths(v, path, out)
    } else {
      out.push([path, v])
    }
  }
  return out
}

/** Summarize a value to a max string length */
export function summarize(obj: any, maxLen = 80): string {
  const s = JSON.stringify(obj)
  return s.length > maxLen ? s.slice(0, maxLen) + '\u2026' : s
}

/** Timestamp string (HH:mm:ss.SSS) */
function ts(): string {
  return new Date().toISOString().slice(11, 23)
}

/** Format a JSON message for display */
export function formatMessage(msg: any, direction: 'IN' | 'OUT', opts: FormatOptions): string | null {
  const type: string = msg.type ?? '?'

  if (opts.quiet && (type === 'COMPONENT_PING' || type === 'COMPONENT_PONG' || type === 'PING' || type === 'PONG')) return null
  if (opts.filter && type !== opts.filter) return null

  const time = color(ts(), C.gray)
  const dir = direction === 'IN'
    ? color(' \u25bc IN ', C.green, C.bold)
    : color(' \u25b2 OUT', C.blue, C.bold)
  const t = color(` ${type} `, colorForType(type), C.bold)

  if (opts.raw) {
    return `${time} ${dir} ${t}\n${JSON.stringify(msg, null, 2)}\n`
  }

  const lines: string[] = [`${time} ${dir} ${t}`]

  switch (type) {
    case 'CONNECTION_ESTABLISHED':
      if (msg.connectionId) lines.push(color(`  connectionId: ${msg.connectionId}`, C.dim))
      break

    case 'STATE_DELTA': {
      const delta = msg.payload?.delta ?? msg.delta
      if (msg.componentId) lines.push(color(`  cid: ${msg.componentId}`, C.dim))
      if (delta) {
        const paths = collectLeafPaths(delta)
        for (const [path, val] of paths.slice(0, 15)) {
          lines.push(color(`  \u0394 ${path}`, C.cyan) + color(` = ${JSON.stringify(val)}`, C.white))
        }
        if (paths.length > 15) lines.push(color(`  ... +${paths.length - 15} more`, C.dim))
      }
      break
    }

    case 'STATE_UPDATE':
    case 'STATE_INIT': {
      if (msg.componentId) lines.push(color(`  cid: ${msg.componentId}`, C.dim))
      const state = msg.payload?.state ?? msg.state ?? msg.result?.state
      if (state) lines.push(color(`  state: ${summarize(state, 120)}`, C.white))
      break
    }

    case 'COMPONENT_MOUNT': {
      const comp = msg.payload?.component ?? msg.component
      if (comp) lines.push(color(`  component: ${comp}`, C.green))
      if (msg.payload?.props) lines.push(color(`  props: ${summarize(msg.payload.props)}`, C.dim))
      break
    }

    case 'COMPONENT_MOUNTED':
    case 'MESSAGE_RESPONSE': {
      if (msg.componentId) lines.push(color(`  cid: ${msg.componentId}`, C.dim))
      if (msg.originalType) lines.push(color(`  originalType: ${msg.originalType}`, C.dim))
      if (msg.result?.componentId) lines.push(color(`  cid: ${msg.result.componentId}`, C.green))
      if (msg.result?.state) lines.push(color(`  state: ${summarize(msg.result.state, 100)}`, C.white))
      if (msg.success === false) lines.push(color(`  success: false`, C.red))
      if (msg.error) lines.push(color(`  error: ${msg.error}`, C.red))
      break
    }

    case 'CALL_ACTION':
    case 'COMPONENT_ACTION': {
      if (msg.componentId) lines.push(color(`  cid: ${msg.componentId}`, C.dim))
      lines.push(color(`  action: ${msg.action ?? '?'}`, C.magenta))
      if (msg.payload && Object.keys(msg.payload).length > 0) {
        lines.push(color(`  payload: ${summarize(msg.payload)}`, C.white))
      }
      break
    }

    case 'ACTION_RESPONSE': {
      if (msg.componentId) lines.push(color(`  cid: ${msg.componentId}`, C.dim))
      if (msg.action) lines.push(color(`  action: ${msg.action}`, C.magenta))
      if (msg.result !== undefined) lines.push(color(`  result: ${summarize(msg.result)}`, C.white))
      if (msg.error) lines.push(color(`  error: ${msg.error}`, C.red))
      break
    }

    case 'ROOM_JOIN':
    case 'ROOM_JOINED': {
      if (msg.roomId ?? msg.payload?.roomId) lines.push(color(`  room: ${msg.roomId ?? msg.payload?.roomId}`, C.yellow))
      if (msg.componentId) lines.push(color(`  cid: ${msg.componentId}`, C.dim))
      break
    }

    case 'ROOM_EVENT': {
      lines.push(color(`  room: ${msg.roomId ?? '?'}  event: ${msg.event ?? '?'}`, C.yellow))
      if (msg.data) lines.push(color(`  data: ${summarize(msg.data, 120)}`, C.white))
      break
    }

    case 'ROOM_EMIT': {
      const roomId = msg.roomId ?? msg.payload?.roomId
      const event = msg.event ?? msg.payload?.event
      lines.push(color(`  room: ${roomId ?? '?'}  event: ${event ?? '?'}`, C.yellow))
      if (msg.payload?.data ?? msg.data) lines.push(color(`  data: ${summarize(msg.payload?.data ?? msg.data, 120)}`, C.white))
      break
    }

    case 'AUTH':
    case 'AUTH_RESPONSE': {
      if (msg.payload) lines.push(color(`  payload: ${summarize(msg.payload)}`, C.white))
      if (msg.result) lines.push(color(`  result: ${summarize(msg.result)}`, C.white))
      if (msg.success !== undefined) lines.push(color(`  success: ${msg.success}`, msg.success ? C.green : C.red))
      break
    }

    case 'ERROR': {
      if (msg.error) lines.push(color(`  ${msg.error}`, C.red))
      if (msg.componentId) lines.push(color(`  cid: ${msg.componentId}`, C.dim))
      break
    }

    default:
      lines.push(color(`  ${summarize(msg, 200)}`, C.dim))
  }

  return lines.join('\n')
}

/** Format a decoded binary room frame */
export function formatBinaryFrame(frame: {
  frameType: number
  componentId: string
  roomId: string
  event: string
  data: unknown
}, opts: FormatOptions): string | null {
  const typeLabel = frame.frameType === 0x01 ? 'BIN_STATE_DELTA'
    : frame.frameType === 0x02 ? 'BIN_ROOM_EVENT'
    : frame.frameType === 0x03 ? 'BIN_ROOM_STATE'
    : `BIN_0x${frame.frameType.toString(16).padStart(2, '0')}`

  if (opts.filter && opts.filter !== typeLabel && opts.filter !== 'BINARY') return null

  const time = color(ts(), C.gray)
  const dir = color(' \u25bc IN ', C.green, C.bold)
  const t = color(` ${typeLabel} `, colorForType(typeLabel), C.bold)

  const lines = [`${time} ${dir} ${t}`]
  if (frame.componentId) lines.push(color(`  cid: ${frame.componentId}`, C.dim))
  lines.push(color(`  room: ${frame.roomId}  event: ${frame.event}`, C.yellow))
  lines.push(color(`  data: ${summarize(frame.data, 200)}`, C.white))

  return lines.join('\n')
}
