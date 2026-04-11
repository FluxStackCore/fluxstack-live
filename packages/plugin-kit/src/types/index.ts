/**
 * Public type barrel for @fluxstack/plugin-kit.
 *
 * All plugin system types are exported here. Host apps and plugin
 * authors should import from `@fluxstack/plugin-kit` directly rather
 * than reaching into subpaths.
 */

export type { Logger } from './logger'

export type {
  PluginHook,
  PluginPriority,
  PluginLifecycleEvent,
  HookExecutionOptions,
} from './hooks'

export type {
  PluginClientHooksAPI,
  PluginUtils,
  PluginConfigSchema,
  PluginContext,
  RequestContext,
  ResponseContext,
  ErrorContext,
  RouteContext,
  ValidationContext,
  TransformContext,
  BuildContext,
  BuildAssetContext,
  BuildErrorContext,
  ConfigLoadContext,
  PluginEventContext,
} from './context'

export type {
  CliArgument,
  CliOption,
  CliCommand,
  CliContext,
} from './cli'

export type { Plugin } from './plugin'
export type { FluxStack } from './plugin'

export type {
  PluginManifest,
  PluginLoadResult,
  PluginRegistryState,
  PluginHookResult,
  PluginMetrics,
  PluginDiscoveryOptions,
  PluginInstallOptions,
  PluginExecutionContext,
  PluginValidationResult,
} from './manifest'
