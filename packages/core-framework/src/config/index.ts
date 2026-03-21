/**
 * ⚡ FluxStack Config System
 *
 * Laravel-style: sensible defaults built-in, override only what you need.
 *
 * @example
 * ```ts
 * import { configProvider, getConfig } from '@fluxstack/core'
 *
 * // Override defaults (optional — call BEFORE FluxStackFramework):
 * configProvider.merge({
 *   app: { name: 'MyApp', version: '2.0.0' },
 *   server: { port: 8080 }
 * })
 *
 * // Access config anywhere:
 * const port = getConfig('server').port       // 8080
 * const appName = getConfig('app').name       // 'MyApp'
 * const full = getConfig()                    // FluxStackConfig
 * ```
 */

// Provider (singleton)
export { configProvider, getConfig, type DeepPartial } from './provider'

// Types
export type {
  FluxStackConfig,
  AppConfig,
  ServerConfig,
  CorsConfig,
  ClientConfig,
  ClientBuildConfig,
  BuildConfig,
  OptimizationConfig,
  LoggerConfig,
  PluginsConfig,
  MonitoringConfig,
  MetricsConfig,
  ProfilingConfig,
  RuntimeConfig,
  DatabaseConfig,
  ServicesConfig,
  AuthConfig,
  SessionConfig,
  SystemConfig,
} from './types'

// Default loader (for advanced use)
export { loadDefaultConfig } from './defaults'

// Config schema utilities (defineConfig, etc.)
export {
  defineConfig,
  defineNestedConfig,
  defineReactiveConfig,
  ReactiveConfig,
  validateConfig,
  config,
  envString,
  envNumber,
  envBoolean,
  envArray,
  envEnum,
  type ConfigField,
  type ConfigFieldType,
  type ConfigSchema,
  type InferConfig,
  type ValidationError,
  type ValidationResult,
} from '../utils/config-schema'

// Legacy type aliases
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type BuildTarget = 'bun' | 'node' | 'docker'
export type LogFormat = 'json' | 'pretty'

// Environment utilities
import { helpers } from '../utils/env'

/**
 * Get environment information
 */
export function getEnvironmentInfo() {
  const getName = () => {
    if (helpers.isDevelopment()) return 'development'
    if (helpers.isProduction()) return 'production'
    if (helpers.isTest()) return 'test'
    return 'development'
  }

  return {
    name: getName(),
    isDevelopment: helpers.isDevelopment(),
    isProduction: helpers.isProduction(),
    isTest: helpers.isTest(),
  }
}
