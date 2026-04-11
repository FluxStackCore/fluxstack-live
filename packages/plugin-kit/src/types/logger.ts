/**
 * Logger interface for plugin system.
 *
 * Defined structurally inside the lib so plugin-kit has **zero** runtime
 * dependency on any host-app logger implementation. Any host app
 * (FluxStack, a hypothetical third-party consumer, a test harness)
 * can inject any object with this shape.
 *
 * The shape is intentionally identical to FluxStack's
 * `core/utils/logger/index.ts#Logger` so that the app's real logger
 * is assignable to `PluginContext.logger` with no adapter.
 */
export interface Logger {
  debug: (message: unknown, ...args: unknown[]) => void
  info: (message: unknown, ...args: unknown[]) => void
  warn: (message: unknown, ...args: unknown[]) => void
  error: (message: unknown, ...args: unknown[]) => void
  request: (method: string, path: string, status?: number, duration?: number, ip?: string) => void
  plugin: (pluginName: string, message: string, meta?: unknown) => void
  framework: (message: string, meta?: unknown) => void
  time: (label: string) => void
  timeEnd: (label: string) => void
  child?: (context: Record<string, unknown>) => Logger
}
