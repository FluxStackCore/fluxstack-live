// @fluxstack/live - Per-component logging control
//
// Silent by default - opt-in via static logging property.
//
// Usage in LiveComponent subclass:
//   static logging = true                           // all categories
//   static logging = ['lifecycle', 'messages']      // specific categories only
//   // (omit or set false -> silent)
//
// Categories:
//   lifecycle    - mount, unmount, rehydration, recovery, migration
//   messages     - received/sent WebSocket messages, file uploads
//   state        - signing, backup, compression, encryption, validation
//   performance  - monitoring init, alerts, optimization suggestions
//   rooms        - room create/join/leave, emit, broadcast
//   websocket    - connection open/close, auth
//
// Console output controlled by LIVE_LOGGING env var:
//   LIVE_LOGGING=true                -> all global logs to console
//   LIVE_LOGGING=lifecycle,rooms     -> only these categories to console
//   (unset or 'false')              -> silent console (default)
//
// Debug panel: All liveLog/liveWarn calls are always forwarded to the Live Debugger
// (when available) as LOG events, regardless of LIVE_LOGGING setting.

export type LiveLogCategory = 'lifecycle' | 'messages' | 'state' | 'performance' | 'rooms' | 'websocket'

export type LiveLogConfig = boolean | readonly LiveLogCategory[]

// Registry: componentId -> resolved logging config
const componentConfigs = new Map<string, LiveLogConfig>()

// Parse global config from env (lazy, cached)
let globalConfigParsed = false
let globalConfig: LiveLogConfig = false

function parseGlobalConfig(): LiveLogConfig {
  if (globalConfigParsed) return globalConfig
  globalConfigParsed = true

  const envValue = typeof process !== 'undefined' ? process.env?.LIVE_LOGGING : undefined
  if (!envValue || envValue === 'false') {
    globalConfig = false
  } else if (envValue === 'true') {
    globalConfig = true
  } else {
    // Comma-separated categories: "lifecycle,rooms,messages"
    globalConfig = envValue.split(',').map(s => s.trim()).filter(Boolean) as LiveLogCategory[]
  }
  return globalConfig
}

/**
 * Register a component's logging config (called on mount)
 */
export function registerComponentLogging(componentId: string, config: LiveLogConfig | undefined): void {
  if (config !== undefined && config !== false) {
    componentConfigs.set(componentId, config)
  }
}

/**
 * Unregister component logging (called on unmount/cleanup)
 */
export function unregisterComponentLogging(componentId: string): void {
  componentConfigs.delete(componentId)
}

/**
 * Check if a log should be emitted for a given component + category
 */
function shouldLog(componentId: string | null, category: LiveLogCategory): boolean {
  if (componentId) {
    const config = componentConfigs.get(componentId)
    if (config === undefined || config === false) return false
    if (config === true) return true
    return config.includes(category)
  }
  // Global log (no specific component)
  const cfg = parseGlobalConfig()
  if (cfg === false) return false
  if (cfg === true) return true
  return cfg.includes(category)
}

// ===== Debugger Integration (injectable) =====
// The debugger is injected lazily to avoid circular dependencies.

interface LiveDebuggerLike {
  enabled: boolean
  emit(type: string, componentId: string | null, componentName: string | null, data: Record<string, unknown>): void
}

let _debugger: LiveDebuggerLike | null = null

/** @internal Inject debugger instance for log forwarding */
export function _setLoggerDebugger(dbg: LiveDebuggerLike): void {
  _debugger = dbg
}

/**
 * Forward a log entry to the Live Debugger as a LOG event.
 * Always emits when the debugger is enabled, regardless of console logging config.
 */
function emitToDebugger(category: LiveLogCategory, level: 'info' | 'warn', componentId: string | null, message: string, args: unknown[]): void {
  if (!_debugger?.enabled) return

  const data: Record<string, unknown> = { category, level, message }
  if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
    data.details = args[0]
  } else if (args.length > 0) {
    data.details = args
  }

  _debugger.emit('LOG', componentId, null, data)
}

/**
 * Log a message gated by the component's logging config.
 * Always forwarded to the Live Debugger when active.
 */
export function liveLog(category: LiveLogCategory, componentId: string | null, message: string, ...args: unknown[]): void {
  // Always forward to debug panel
  emitToDebugger(category, 'info', componentId, message, args)

  // Console output gated by config
  if (shouldLog(componentId, category)) {
    if (args.length > 0) {
      console.log(message, ...args)
    } else {
      console.log(message)
    }
  }
}

/**
 * Warn-level log gated by config.
 * Always forwarded to the Live Debugger when active.
 */
export function liveWarn(category: LiveLogCategory, componentId: string | null, message: string, ...args: unknown[]): void {
  // Always forward to debug panel
  emitToDebugger(category, 'warn', componentId, message, args)

  // Console output gated by config
  if (shouldLog(componentId, category)) {
    if (args.length > 0) {
      console.warn(message, ...args)
    } else {
      console.warn(message)
    }
  }
}
