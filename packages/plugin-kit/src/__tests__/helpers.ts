// Utilitários de teste do plugin-kit: logger que grava chamadas e fixtures de
// plugin em diretório temporário (para discovery/registry/module-resolver).
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { Logger } from '../types/logger'
import type { Plugin } from '../types/plugin'

export interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  meta: unknown[]
}

export interface MemoryLogger extends Logger {
  entries: LogEntry[]
  childContexts: Record<string, unknown>[]
  /** mensagens de um nível (texto) */
  messages(level: LogEntry['level']): string[]
}

export function memoryLogger(): MemoryLogger {
  const entries: LogEntry[] = []
  const childContexts: Record<string, unknown>[] = []
  const at = (level: LogEntry['level']) => (message: unknown, ...meta: unknown[]) => {
    entries.push({ level, message: String(message), meta })
  }
  const logger: MemoryLogger = {
    entries,
    childContexts,
    messages: (level) => entries.filter((e) => e.level === level).map((e) => e.message),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    request: () => {},
    plugin: () => {},
    framework: () => {},
    time: () => {},
    timeEnd: () => {},
    child: (context) => {
      childContexts.push(context)
      return logger
    },
  }
  return logger
}

/** Plugin mínimo (o `Plugin` aceita chaves extras). */
export function plugin(name: string, extra: Partial<Plugin> = {}): Plugin {
  return { name, ...extra } as Plugin
}

/** Diretório temporário com arquivos; `cleanup()` apaga tudo. */
export function tempDir(files: Record<string, string> = {}): { root: string; write: (rel: string, content: string) => string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'plugin-kit-test-'))
  const write = (rel: string, content: string) => {
    const full = join(root, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
    return full
  }
  for (const [rel, content] of Object.entries(files)) write(rel, content)
  return { root, write, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** Código ESM de um plugin que exporta `{ name, ...campos }` (hooks viram funções vazias). */
export function pluginModule(name: string, opts: { version?: string; hooks?: string[]; dependencies?: string[]; extra?: string } = {}): string {
  const fields = [`name: ${JSON.stringify(name)}`]
  if (opts.version) fields.push(`version: ${JSON.stringify(opts.version)}`)
  if (opts.dependencies) fields.push(`dependencies: ${JSON.stringify(opts.dependencies)}`)
  for (const h of opts.hooks ?? []) fields.push(`${h}: () => {}`)
  if (opts.extra) fields.push(opts.extra)
  return `export default { ${fields.join(', ')} }\n`
}
