/**
 * Runtime exports barrel.
 *
 * Everything here is runtime code (classes, functions, values) as
 * opposed to the `types/` barrel which is type-only.
 */

export { PluginError } from './errors'
export { PluginModuleResolver, type ModuleResolverConfig } from './module-resolver'
export {
  PluginDependencyManager,
  type PluginDependency,
  type DependencyResolution,
  type DependencyConflict,
  type DependencyManagerConfig,
} from './dependency-manager'
export { PluginDiscovery, type PluginDiscoveryConfig } from './discovery'
export {
  PluginExecutor,
  calculateExecutionStats,
  type PluginExecutionPlan,
  type PluginExecutionStep,
  type PluginExecutionStats,
} from './executor'
export {
  PluginRegistry,
  type PluginRegistryConfig,
  type PluginRegistrySettings,
} from './registry'
export {
  PluginManager,
  createRequestContext,
  createResponseContext,
  createErrorContext,
  createBuildContext,
  type PluginManagerConfig,
} from './manager'
export { createPluginUtils } from './utils'
