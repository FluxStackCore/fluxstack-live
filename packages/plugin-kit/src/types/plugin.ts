/**
 * The Plugin interface — authors implement this to build a plugin.
 *
 * Generic over `TConfig` so plugin authors can specialize if they want
 * to type-check against the host app's config shape:
 *
 * ```ts
 * // FluxStack consumer:
 * import type { Plugin } from '@fluxstack/plugin-kit'
 * import type { FluxStackConfig } from '@config'
 *
 * const myPlugin: Plugin<FluxStackConfig> = {
 *   name: 'my-plugin',
 *   setup: async (ctx) => {
 *     ctx.config.logging.level // fully typed against FluxStackConfig
 *   }
 * }
 * ```
 *
 * Or leave `TConfig` defaulted to `unknown` for framework-agnostic plugins.
 */

import type { PluginPriority } from './hooks'
import type {
  PluginContext,
  ConfigLoadContext,
  RequestContext,
  RouteContext,
  ResponseContext,
  ValidationContext,
  TransformContext,
  ErrorContext,
  BuildContext,
  BuildAssetContext,
  BuildErrorContext,
  PluginEventContext,
} from './context'
import type { CliCommand } from './cli'

export interface Plugin<TConfig = unknown> {
  name: string
  version?: string
  description?: string
  author?: string
  dependencies?: string[]
  priority?: number | PluginPriority
  category?: string
  tags?: string[]

  // Lifecycle hooks
  setup?: (context: PluginContext<TConfig>) => void | Promise<void>
  onConfigLoad?: (context: ConfigLoadContext<TConfig>) => void | Promise<void>
  onBeforeServerStart?: (context: PluginContext<TConfig>) => void | Promise<void>
  onServerStart?: (context: PluginContext<TConfig>) => void | Promise<void>
  onAfterServerStart?: (context: PluginContext<TConfig>) => void | Promise<void>
  onBeforeServerStop?: (context: PluginContext<TConfig>) => void | Promise<void>
  onServerStop?: (context: PluginContext<TConfig>) => void | Promise<void>

  // Request/Response pipeline hooks
  onRequest?: (context: RequestContext) => void | Promise<void>
  onBeforeRoute?: (context: RequestContext) => void | Promise<void>
  onAfterRoute?: (context: RouteContext) => void | Promise<void>
  onBeforeResponse?: (context: ResponseContext) => void | Promise<void>
  onResponse?: (context: ResponseContext) => void | Promise<void>
  onRequestValidation?: (context: ValidationContext) => void | Promise<void>
  onResponseTransform?: (context: TransformContext) => void | Promise<void>

  // Error handling hooks
  onError?: (context: ErrorContext) => void | Promise<void>

  // Build pipeline hooks
  onBeforeBuild?: (context: BuildContext<TConfig>) => void | Promise<void>
  onBuild?: (context: BuildContext<TConfig>) => void | Promise<void>
  onBuildAsset?: (context: BuildAssetContext) => void | Promise<void>
  onBuildComplete?: (context: BuildContext<TConfig>) => void | Promise<void>
  onBuildError?: (context: BuildErrorContext) => void | Promise<void>

  // Plugin system hooks
  onPluginRegister?: (context: PluginEventContext) => void | Promise<void>
  onPluginUnregister?: (context: PluginEventContext) => void | Promise<void>
  onPluginError?: (context: PluginEventContext & { error: Error }) => void | Promise<void>

  // CLI commands
  commands?: CliCommand<TConfig>[]

  // Allow additional properties for host-app extensions (e.g. FluxStack's
  // `plugin` property that carries an Elysia sub-app)
  [key: string]: unknown
}

/**
 * Backward-compatible namespace. FluxStack's legacy code uses
 * `FluxStack.Plugin` as the plugin type — this namespace preserves
 * that form so migration is a drop-in import change.
 *
 * Because `isolatedModules` requires top-level `export namespace`
 * forms to be erasable, we expose this as a plain type alias with
 * a nested type. Consumers write `FluxStack.Plugin<Config>` exactly
 * as before.
 */
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace FluxStack {
  // eslint-disable-next-line @typescript-eslint/no-shadow
  export type Plugin<TConfig = unknown> = import('./plugin').Plugin<TConfig>
}
