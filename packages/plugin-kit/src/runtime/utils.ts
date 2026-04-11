/**
 * Default implementation of `PluginUtils`.
 *
 * Creates the utility helper object that gets injected into every
 * `PluginContext.utils`. These are small, stateless helpers plugins
 * use for common tasks (timing, byte formatting, env detection,
 * hashing, deep merging, schema validation).
 */

import type { PluginUtils, PluginConfigSchema } from '../types/context'
import type { Logger } from '../types/logger'

/**
 * Deep-merge two plain objects. Source values win on conflict.
 * Exported here so `createPluginUtils` can bind it and consumers
 * don't need a third-party dep just for this.
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target }

  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const sourceValue = source[key]
      const targetValue = result[key]

      if (
        typeof sourceValue === 'object' &&
        sourceValue !== null &&
        !Array.isArray(sourceValue) &&
        typeof targetValue === 'object' &&
        targetValue !== null &&
        !Array.isArray(targetValue)
      ) {
        result[key] = deepMerge(
          targetValue as Record<string, unknown>,
          sourceValue as Record<string, unknown>,
        )
      } else {
        result[key] = sourceValue
      }
    }
  }

  return result
}

/**
 * Validate a plain data object against a simple plugin config schema.
 * Only checks `required` for now — good enough for host-app plugin
 * authors who want a quick sanity check without pulling in a full
 * JSON-Schema validator.
 */
function validateSchema(
  data: Record<string, unknown>,
  schema: PluginConfigSchema,
): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (schema.required) {
    for (const requiredField of schema.required) {
      if (!(requiredField in data)) {
        errors.push(`Missing required field: ${requiredField}`)
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

/**
 * Build a `PluginUtils` helper object. Pass a `logger` so the
 * `createTimer` helper can log durations at debug level.
 */
export function createPluginUtils(logger?: Logger): PluginUtils {
  return {
    createTimer: (label: string) => {
      const start = Date.now()
      return {
        end: () => {
          const duration = Date.now() - start
          logger?.debug(`Timer '${label}' completed`, { duration })
          return duration
        },
      }
    },

    formatBytes: (bytes: number): string => {
      if (bytes === 0) return '0 Bytes'
      const k = 1024
      const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB']
      const i = Math.floor(Math.log(bytes) / Math.log(k))
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
    },

    isProduction: (): boolean => process.env.NODE_ENV === 'production',
    isDevelopment: (): boolean => process.env.NODE_ENV === 'development',
    getEnvironment: (): string => process.env.NODE_ENV || 'development',

    createHash: (data: string): string => {
      // Simple non-cryptographic hash. Callers that need crypto should
      // not use this — it's here for plugin ID generation / cache keys.
      let hash = 0
      for (let i = 0; i < data.length; i++) {
        const char = data.charCodeAt(i)
        hash = (hash << 5) - hash + char
        hash = hash & hash // 32-bit int
      }
      return hash.toString(36)
    },

    deepMerge,
    validateSchema,
  }
}
