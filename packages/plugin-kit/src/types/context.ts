/**
 * Hook context types — what each hook receives when invoked.
 *
 * Config-bearing contexts are generic over `TConfig` so each host app
 * can specialize without the lib needing to know the shape.
 */

import type { Logger } from './logger'

/**
 * API that plugins use to inject client-side JavaScript at hook points.
 * The concrete registry implementation lives in the host app (in FluxStack,
 * `core/server/plugin-client-hooks.ts`) and is passed into plugin-kit via
 * `PluginContext.clientHooks`.
 */
export interface PluginClientHooksAPI {
  /**
   * Register JavaScript code to be executed on the client at a specific
   * hook point.
   *
   * FluxStack built-in hook points:
   * - 'onEdenInit'    — runs after the Eden Treaty client is created
   * - 'onLiveConnect' — runs when the LiveComponents WebSocket connects
   *
   * Other host apps can define their own hook points.
   */
  register(hookName: string, jsCode: string): void
}

export interface PluginUtils {
  createTimer: (label: string) => { end: () => number }
  formatBytes: (bytes: number) => string
  isProduction: () => boolean
  isDevelopment: () => boolean
  getEnvironment: () => string
  createHash: (data: string) => string
  deepMerge: (
    target: Record<string, unknown>,
    source: Record<string, unknown>,
  ) => Record<string, unknown>
  validateSchema: (
    data: Record<string, unknown>,
    schema: PluginConfigSchema,
  ) => { valid: boolean; errors: string[] }
}

export interface PluginConfigSchema {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
}

/**
 * The context passed to lifecycle hooks like `setup`, `onServerStart`, etc.
 *
 * @typeParam TConfig - Shape of the host app's config object. Defaults to
 * `unknown` so plugins that don't care about the concrete shape don't need
 * to specify it.
 */
export interface PluginContext<TConfig = unknown> {
  config: TConfig
  logger: Logger
  app: unknown // Host app instance (e.g. an Elysia app in FluxStack)
  utils: PluginUtils
  registry?: unknown // Plugin registry reference
  /** Register client-side JS hooks that plugins can inject */
  clientHooks: PluginClientHooksAPI
}

/**
 * Base request context — passed to request/response pipeline hooks.
 */
export interface RequestContext {
  request: Request
  path: string
  method: string
  headers: Record<string, string>
  query: Record<string, string>
  params: Record<string, string>
  body?: unknown
  user?: unknown
  startTime: number
  handled?: boolean
  response?: Response
}

export interface ResponseContext extends RequestContext {
  response: Response
  statusCode: number
  duration: number
  size?: number
}

export interface ErrorContext extends RequestContext {
  error: Error
  duration: number
  handled: boolean
}

export interface RouteContext extends RequestContext {
  route?: string
  handler?: Function
  params: Record<string, string>
}

export interface ValidationContext extends RequestContext {
  errors: Array<{ field: string; message: string; code: string }>
  isValid: boolean
}

export interface TransformContext extends ResponseContext {
  transformed: boolean
  originalResponse?: Response
}

/**
 * Build pipeline contexts. `TConfig` for the same reason as `PluginContext`.
 */
export interface BuildContext<TConfig = unknown> {
  target: string
  outDir: string
  mode: 'development' | 'production'
  config: TConfig
}

export interface BuildAssetContext {
  assetPath: string
  assetType: 'js' | 'css' | 'html' | 'image' | 'font' | 'other'
  size: number
  content?: string | Uint8Array
}

export interface BuildErrorContext {
  error: Error
  file?: string
  line?: number
  column?: number
}

export interface ConfigLoadContext<TConfig = unknown> {
  config: TConfig
  envVars: Record<string, string | undefined>
  configPath?: string
}

export interface PluginEventContext {
  pluginName: string
  pluginVersion?: string
  timestamp: number
  data?: unknown
}
