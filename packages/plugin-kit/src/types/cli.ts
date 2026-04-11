/**
 * CLI command types — plugins can expose commands that the FluxStack
 * CLI (or any host-app CLI) can run.
 */

import type { Logger } from './logger'
import type { PluginUtils } from './context'

export interface CliArgument {
  name: string
  description: string
  required?: boolean
  type?: 'string' | 'number' | 'boolean'
  default?: unknown
  choices?: string[]
}

export interface CliOption {
  name: string
  short?: string
  description: string
  type?: 'string' | 'number' | 'boolean' | 'array'
  default?: unknown
  required?: boolean
  choices?: string[]
}

export interface CliCommand<TConfig = unknown> {
  name: string
  description: string
  usage?: string
  examples?: string[]
  arguments?: CliArgument[]
  options?: CliOption[]
  aliases?: string[]
  category?: string
  hidden?: boolean
  handler: (
    args: unknown[],
    options: Record<string, unknown>,
    context: CliContext<TConfig>,
  ) => Promise<void> | void
}

export interface CliContext<TConfig = unknown> {
  config: TConfig
  logger: Logger
  utils: PluginUtils
  workingDir: string
  packageInfo: {
    name: string
    version: string
  }
}
