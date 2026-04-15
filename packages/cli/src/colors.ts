// @fluxstack/live-cli — ANSI color helpers

export const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  italic:  '\x1b[3m',
  underline: '\x1b[4m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  white:   '\x1b[37m',
  gray:    '\x1b[90m',
  bgRed:   '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow:'\x1b[43m',
  bgBlue:  '\x1b[44m',
  bgCyan:  '\x1b[46m',
} as const

export function color(s: string, ...codes: string[]): string {
  return codes.join('') + s + C.reset
}

/** Map message type → ANSI color code */
export function colorForType(type: string): string {
  switch (type) {
    // Connection
    case 'CONNECTION_ESTABLISHED': return C.green + C.bold
    // Component lifecycle
    case 'COMPONENT_MOUNT':
    case 'COMPONENT_MOUNTED':
    case 'COMPONENT_UNMOUNT':   return C.green
    case 'COMPONENT_REHYDRATE':
    case 'COMPONENT_REHYDRATED': return C.green + C.dim
    // State
    case 'STATE_INIT':
    case 'STATE_UPDATE':        return C.green + C.bold
    case 'STATE_DELTA':         return C.cyan
    case 'STATE_REHYDRATED':    return C.cyan + C.dim
    // Actions
    case 'CALL_ACTION':
    case 'COMPONENT_ACTION':    return C.magenta
    case 'ACTION_RESPONSE':
    case 'MESSAGE_RESPONSE':    return C.magenta + C.dim
    // Rooms
    case 'ROOM_JOIN':
    case 'ROOM_JOINED':         return C.yellow + C.bold
    case 'ROOM_LEAVE':
    case 'ROOM_LEFT':           return C.yellow + C.dim
    case 'ROOM_EVENT':
    case 'ROOM_EMIT':           return C.yellow
    case 'ROOM_STATE':
    case 'ROOM_STATE_SET':
    case 'ROOM_STATE_GET':
    case 'ROOM_SYSTEM':         return C.yellow + C.dim
    // Auth
    case 'AUTH':
    case 'AUTH_RESPONSE':       return C.blue + C.bold
    // Errors
    case 'ERROR':               return C.red + C.bold
    // Ping/Pong
    case 'COMPONENT_PING':
    case 'COMPONENT_PONG':
    case 'PING':
    case 'PONG':                return C.gray
    // Binary
    case 'BIN_ROOM_EVENT':      return C.yellow + C.bold
    case 'BIN_ROOM_STATE':      return C.cyan + C.bold
    case 'BIN_STATE_DELTA':     return C.cyan
    // Default
    default:                    return C.white
  }
}
