/**
 * Plugin hook names and lifecycle events.
 */

export type PluginHook =
  // Lifecycle hooks
  | 'setup'
  | 'onConfigLoad'
  | 'onBeforeServerStart'
  | 'onServerStart'
  | 'onAfterServerStart'
  | 'onBeforeServerStop'
  | 'onServerStop'
  // Request/Response pipeline hooks
  | 'onRequest'
  | 'onBeforeRoute'
  | 'onAfterRoute'
  | 'onBeforeResponse'
  | 'onResponse'
  | 'onRequestValidation'
  | 'onResponseTransform'
  // Error handling hooks
  | 'onError'
  // Build pipeline hooks
  | 'onBeforeBuild'
  | 'onBuild'
  | 'onBuildAsset'
  | 'onBuildComplete'
  | 'onBuildError'
  // Plugin system hooks
  | 'onPluginRegister'
  | 'onPluginUnregister'
  | 'onPluginError'

export type PluginPriority = 'highest' | 'high' | 'normal' | 'low' | 'lowest' | number

export type PluginLifecycleEvent =
  | 'plugin:registered'
  | 'plugin:unregistered'
  | 'plugin:enabled'
  | 'plugin:disabled'
  | 'plugin:error'
  | 'hook:before'
  | 'hook:after'
  | 'hook:error'

export interface HookExecutionOptions {
  timeout?: number
  parallel?: boolean
  stopOnError?: boolean
  retries?: number
}
