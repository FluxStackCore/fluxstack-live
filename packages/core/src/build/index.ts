// @fluxstack/live/build - Build utilities
//
// Vite plugin to strip server code from Live Component imports.
// Ensures server-side logic never reaches the browser.
//
// Usage in vite.config.ts:
//   import { liveStripPlugin } from '@fluxstack/live/build'
//
//   export default defineConfig({
//     plugins: [liveStripPlugin({ serverDir: 'src/server/live' })]
//   })

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'fs'
import { resolve, dirname, join } from 'path'
import type { Plugin, ModuleNode } from 'vite'

export const BUILD_VERSION = '0.1.0'

// ===== Types =====

export interface LiveStripPluginOptions {
  /** Import prefix that triggers stripping. Default: '@server/live/' */
  importPrefix?: string
  /** Resolve server files relative to this base path. Default: auto-detected from Vite config */
  serverDir?: string
  /** Directory for generated stubs (relative to Vite root). Default: '.live-stubs' */
  stubDir?: string
  /** Enable verbose logging. Default: false */
  verbose?: boolean
}

// ===== Metadata Extraction =====

interface ComponentMeta {
  className: string
  componentName: string
  defaultState: string
  publicActions: string
}

/** Read a server .ts file and pull out the 3 static fields we need. */
function extractMeta(filePath: string): ComponentMeta[] {
  const src = readFileSync(filePath, 'utf-8')
  const results: ComponentMeta[] = []

  const re = /export\s+class\s+(\w+)\s+extends\s+LiveComponent/g
  let m: RegExpExecArray | null

  while ((m = re.exec(src)) !== null) {
    const className = m[1]!
    const body = extractBlock(src, src.indexOf('{', m.index))

    const name = body.match(/static\s+componentName\s*=\s*['"]([^'"]+)['"]/)?.[1] ?? className
    const actions = body.match(/static\s+publicActions\s*=\s*(\[[^\]]*\])/)?.[1] ?? '[]'
    const state = extractDefaultState(body)

    results.push({ className, componentName: name, defaultState: state, publicActions: actions })
  }

  return results
}

/** Extract a brace-balanced block starting at position `start`. */
function extractBlock(src: string, start: number): string {
  let depth = 1, i = start + 1
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') depth--
    i++
  }
  return src.substring(start, i)
}

/** Pull out `static defaultState = { ... }` and strip TS type casts. */
function extractDefaultState(classBody: string): string {
  const m = classBody.match(/static\s+defaultState\s*=\s*/)
  if (!m) return '{}'

  const objStart = classBody.indexOf('{', m.index! + m[0].length)
  if (objStart === -1) return '{}'

  const raw = extractBlock(classBody, objStart)
  return stripAsCasts(raw)
}

/**
 * Remove `as <Type>` casts, handling nested generics/brackets.
 */
function stripAsCasts(s: string): string {
  const RE = /\s+as\s+/g
  let out = '', last = 0, m: RegExpExecArray | null

  while ((m = RE.exec(s)) !== null) {
    out += s.slice(last, m.index)
    let i = m.index + m[0].length
    const stack: string[] = []

    while (i < s.length) {
      const c = s[i]
      if (c === '{' || c === '<' || c === '(') { stack.push(c === '{' ? '}' : c === '<' ? '>' : ')'); i++ }
      else if (c === '[' && s[i + 1] === ']') { i += 2 }
      else if (c === '[') { stack.push(']'); i++ }
      else if (stack.length && c === stack[stack.length - 1]) { stack.pop(); i++; while (s[i] === '[' && s[i + 1] === ']') i += 2 }
      else if (!stack.length && (c === ',' || c === '\n' || c === '}')) break
      else i++
    }
    last = i
  }

  return out + s.slice(last)
}

// ===== Stub Generation =====

function buildStub(metas: ComponentMeta[]): string {
  if (!metas.length) return 'export {}'
  return metas.map(m =>
    `export class ${m.className} {\n` +
    `  static componentName = '${m.componentName}'\n` +
    `  static defaultState = ${m.defaultState}\n` +
    `  static publicActions = ${m.publicActions}\n` +
    `}`
  ).join('\n\n')
}

// ===== Plugin =====

function norm(p: string) { return p.replace(/\\/g, '/') }

/**
 * Vite plugin to strip server-only code from Live Component imports.
 *
 * When client code imports from `@server/live/MyComponent`, this plugin
 * intercepts and redirects to a tiny stub that exports only:
 * - static componentName
 * - static defaultState
 * - static publicActions
 *
 * This ensures server logic never reaches the browser bundle.
 */
export function liveStripPlugin(options: LiveStripPluginOptions = {}): Plugin {
  const {
    importPrefix = '@server/live/',
    stubDir: stubDirName = '.live-stubs',
    verbose = false,
  } = options

  let projectRoot: string
  let stubDir: string
  const nameToFile = new Map<string, string>()
  const fileToName = new Map<string, string>()
  const cache = new Map<string, string>()

  const log = verbose ? (msg: string) => console.log(`[live-strip] ${msg}`) : () => {}

  function writeStub(name: string, serverPath: string): string {
    const stubPath = join(stubDir, `${name}.js`)
    const content = buildStub(extractMeta(serverPath))
    if (cache.get(name) !== content) {
      writeFileSync(stubPath, content, 'utf-8')
      cache.set(name, content)
      log(`Generated stub: ${name}`)
    }
    return stubPath
  }

  return {
    name: 'fluxstack-live-strip',
    enforce: 'pre',

    configResolved(config) {
      projectRoot = config.configFile ? dirname(config.configFile) : resolve(config.root, '../..')
      stubDir = join(config.root, stubDirName)
      if (!existsSync(stubDir)) mkdirSync(stubDir, { recursive: true })
    },

    resolveId(source, importer) {
      if (!source.startsWith(importPrefix) || !importer) return null

      const imp = norm(importer)
      // Only strip imports from client code
      if (!imp.includes('/client/') && !imp.includes('/app/client/')) return null

      const name = source.replace(importPrefix, '')

      // Resolve the server-side source file
      let serverBase: string
      if (options.serverDir) {
        serverBase = resolve(projectRoot, options.serverDir)
      } else {
        serverBase = resolve(projectRoot, source.replace('@server/', 'app/server/'))
      }

      const ts = serverBase.endsWith('.ts') ? serverBase : serverBase + '.ts'

      nameToFile.set(name, ts)
      fileToName.set(norm(ts), name)

      return writeStub(name, ts)
    },

    handleHotUpdate({ file, server }): ModuleNode[] | void {
      const name = fileToName.get(norm(file))
      if (!name) return

      const serverPath = nameToFile.get(name)!
      const oldContent = cache.get(name)
      const newContent = buildStub(extractMeta(serverPath))

      if (newContent === oldContent) return []

      writeStub(name, serverPath)

      const stubPath = norm(join(stubDir, `${name}.js`))
      const mods = server.moduleGraph.getModulesByFile(stubPath)
      if (mods?.size) {
        const arr = [...mods]
        arr.forEach(m => server.moduleGraph.invalidateModule(m))
        server.config.logger.info(`[live-strip] HMR: ${name} metadata changed`, { timestamp: true })
        return arr
      }
    },

    buildEnd() {
      if (existsSync(stubDir)) rmSync(stubDir, { recursive: true, force: true })
    },
  }
}
