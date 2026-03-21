/**
 * FluxStack Logger Configuration
 * Re-export from declarative config
 */

import { getConfig } from '../../config'

export interface LoggerConfig {
  level: 'debug' | 'info' | 'warn' | 'error'
  format: 'pretty' | 'json'
  dateFormat: string
  logToFile: boolean
  maxSize: string
  maxFiles: string
  objectDepth: number
  enableColors: boolean
  enableStackTrace: boolean
  transports: string[]
}

/**
 * Get logger configuration from declarative config
 */
export function getLoggerConfig(): LoggerConfig {
  const loggerCfg = getConfig('logging')
  return {
    level: loggerCfg.level ?? 'info',
    format: loggerCfg.format ?? 'pretty',
    dateFormat: loggerCfg.dateFormat ?? 'YYYY-MM-DD HH:mm:ss',
    logToFile: loggerCfg.logToFile ?? false,
    maxSize: loggerCfg.maxSize ?? '20m',
    maxFiles: loggerCfg.maxFiles ?? '14d',
    objectDepth: loggerCfg.objectDepth ?? 4,
    enableColors: loggerCfg.enableColors ?? true,
    enableStackTrace: loggerCfg.enableStackTrace ?? true,
    transports: loggerCfg.transports ?? ['console']
  }
}

export const LOGGER_CONFIG = getLoggerConfig()
