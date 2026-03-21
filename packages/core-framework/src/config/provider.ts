/**
 * ⚡ FluxStack Config Provider
 *
 * Laravel-style configuration: the framework ships with sensible defaults,
 * and the developer only overrides what they need.
 *
 * Usage:
 *
 * 1. Framework loads internal defaults automatically
 * 2. App calls `configProvider.merge(appOverrides)` to customize
 * 3. All internal code uses `configProvider.get('server')` etc.
 *
 * @example
 * ```ts
 * // In the app (optional - only override what you need):
 * import { configProvider } from '@fluxstack/core'
 *
 * configProvider.merge({
 *   app: { name: 'MyApp', version: '2.0.0' },
 *   server: { server: { port: 8080 } }
 * })
 *
 * // Inside the framework (always works, with or without app overrides):
 * const port = configProvider.get('server').server.port  // 8080 or default 3000
 * ```
 */

import type { FluxStackConfig } from './types'
import { loadDefaultConfig } from './defaults'

type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P]
}

function deepMerge<T extends Record<string, unknown>>(target: T, source: DeepPartial<T>): T {
  const result = { ...target } as Record<string, unknown>

  for (const key in source) {
    const sourceVal = (source as Record<string, unknown>)[key]
    const targetVal = result[key]

    if (
      sourceVal !== null &&
      sourceVal !== undefined &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      typeof targetVal === 'object' &&
      targetVal !== null &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as DeepPartial<Record<string, unknown>>
      )
    } else if (sourceVal !== undefined) {
      result[key] = sourceVal
    }
  }

  return result as T
}

class ConfigProvider {
  private _config: FluxStackConfig | null = null
  private _overrides: DeepPartial<FluxStackConfig> = {}
  private _initialized = false

  /**
   * Get the full resolved config (defaults + overrides).
   * Lazily initializes on first access.
   */
  get config(): FluxStackConfig {
    if (!this._config) {
      this._config = this.resolve()
      this._initialized = true
    }
    return this._config
  }

  /**
   * Get a specific config section
   */
  get<K extends keyof FluxStackConfig>(key: K): FluxStackConfig[K] {
    return this.config[key]
  }

  /**
   * Merge app-level overrides into the config.
   * Call this BEFORE accessing any config values (e.g. before FluxStackFramework).
   *
   * Can be called multiple times — overrides accumulate.
   */
  merge(overrides: DeepPartial<FluxStackConfig>): this {
    this._overrides = deepMerge(
      this._overrides as Record<string, unknown>,
      overrides as DeepPartial<Record<string, unknown>>
    ) as DeepPartial<FluxStackConfig>

    // Invalidate cache so next access re-resolves
    this._config = null
    return this
  }

  /**
   * Replace the entire config (for testing or advanced use).
   */
  set(config: FluxStackConfig): this {
    this._config = config
    this._initialized = true
    return this
  }

  /**
   * Reset to defaults (clears all overrides).
   */
  reset(): this {
    this._overrides = {}
    this._config = null
    this._initialized = false
    return this
  }

  /**
   * Check if config has been accessed/initialized
   */
  get initialized(): boolean {
    return this._initialized
  }

  /**
   * Resolve: load defaults then apply overrides
   */
  private resolve(): FluxStackConfig {
    const defaults = loadDefaultConfig()

    if (Object.keys(this._overrides).length === 0) {
      return defaults
    }

    return deepMerge(
      defaults as unknown as Record<string, unknown>,
      this._overrides as DeepPartial<Record<string, unknown>>
    ) as unknown as FluxStackConfig
  }
}

/**
 * Global config provider singleton.
 *
 * All framework internals use this to access configuration.
 * Apps can call `configProvider.merge()` to override defaults.
 */
export const configProvider = new ConfigProvider()

/**
 * Shorthand to get a config section
 */
export function getConfig(): FluxStackConfig
export function getConfig<K extends keyof FluxStackConfig>(key: K): FluxStackConfig[K]
export function getConfig<K extends keyof FluxStackConfig>(key?: K) {
  if (key) return configProvider.get(key)
  return configProvider.config
}

export type { DeepPartial }
