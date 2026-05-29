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

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'fs'
import { resolve, relative, dirname, join, basename, extname } from 'path'
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
  // Handle optional TS type annotation: `static defaultState: SomeType = { ... }`
  // Supports simple types (State), generics (Record<string, any>), namespaced (Ns.State)
  const m = classBody.match(/static\s+defaultState\s*(?::[^=]+)?=\s*/)
  if (!m) return '{}'

  const objStart = classBody.indexOf('{', m.index! + m[0].length)
  if (objStart === -1) return '{}'

  const raw = extractBlock(classBody, objStart)
  return stripAsCasts(raw)
}

/**
 * Remove `as <Type>` casts, handling nested generics/brackets.
 *
 * Critical: the scan must skip over string literals, template literals, and
 * comments so that user data like `'Use as dicas!'` is never treated as a
 * cast site (issue #33).
 */
function stripAsCasts(s: string): string {
  let out = ''
  let i = 0

  while (i < s.length) {
    const c = s[i]!

    // Skip string literals — quoted content cannot contain a cast.
    if (c === '"' || c === "'" || c === '`') {
      const start = i
      const quote = c
      i++
      while (i < s.length) {
        const ch = s[i]!
        if (ch === '\\') { i += 2; continue }
        if (ch === quote) { i++; break }
        if (quote === '`' && ch === '$' && s[i + 1] === '{') {
          // Skip ${...} expression inside template literal (balanced braces).
          i += 2
          let depth = 1
          while (i < s.length && depth > 0) {
            const e = s[i]!
            if (e === '{') depth++
            else if (e === '}') depth--
            i++
          }
          continue
        }
        i++
      }
      out += s.slice(start, i)
      continue
    }

    // Skip // line comments
    if (c === '/' && s[i + 1] === '/') {
      const start = i
      while (i < s.length && s[i] !== '\n') i++
      out += s.slice(start, i)
      continue
    }

    // Skip /* block comments */
    if (c === '/' && s[i + 1] === '*') {
      const start = i
      i += 2
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++
      i += 2
      out += s.slice(start, i)
      continue
    }

    // Detect ` as ` (with surrounding whitespace) at the current position.
    // Whitespace on both sides guarantees `as` is a standalone token — it
    // cannot be a substring of an identifier like `class` or `wasnt`.
    if (/\s/.test(c) && s.startsWith('as', i + 1) && /\s/.test(s[i + 3] ?? '')) {
      i += 4 // consume ` as `
      const stack: string[] = []
      while (i < s.length) {
        const cc = s[i]!
        // Strings inside the type cast (rare, e.g. `as 'literal'`) must be skipped too.
        if (cc === '"' || cc === "'" || cc === '`') {
          const q = cc
          i++
          while (i < s.length) {
            if (s[i] === '\\') { i += 2; continue }
            if (s[i] === q) { i++; break }
            i++
          }
          continue
        }
        if (cc === '{' || cc === '<' || cc === '(') { stack.push(cc === '{' ? '}' : cc === '<' ? '>' : ')'); i++ }
        else if (cc === '[' && s[i + 1] === ']') { i += 2 }
        else if (cc === '[') { stack.push(']'); i++ }
        else if (stack.length && cc === stack[stack.length - 1]) { stack.pop(); i++; while (s[i] === '[' && s[i + 1] === ']') i += 2 }
        else if (!stack.length && (cc === ',' || cc === '\n' || cc === '}')) break
        else i++
      }
      continue
    }

    out += c
    i++
  }

  return out
}

// ===== Component Discovery & Code Generation =====

export interface GenerateLiveComponentsOptions {
  /** Directory to scan for LiveComponent subclasses. */
  componentsDir: string
  /**
   * Output file path for the generated registration module.
   * Default: `<componentsDir>/auto-generated-components.ts`
   */
  outFile?: string
  /**
   * Import path prefix used in the generated imports.
   * Default: relative imports (`./FileName`)
   */
  importPrefix?: string
}

/**
 * Scan a directory for `LiveComponent` subclasses and generate a TypeScript
 * module that imports them all and exports a `liveComponentClasses` array.
 *
 * The generated file is suitable for passing to `LiveServer({ components })`.
 *
 * Skips writing when the component list hasn't changed (avoids triggering
 * hot-reload loops in dev).
 *
 * @returns number of components found, or -1 if `componentsDir` doesn't exist.
 *
 * @example
 * ```ts
 * import { generateLiveComponentsFile } from '@fluxstack/live/build'
 *
 * // Minimal — generates auto-generated-components.ts next to the components
 * generateLiveComponentsFile({
 *   componentsDir: join(process.cwd(), 'app', 'server', 'live'),
 * })
 *
 * // Full control
 * generateLiveComponentsFile({
 *   componentsDir: join(process.cwd(), 'app', 'server', 'live'),
 *   outFile: join(process.cwd(), 'core', 'server', 'live', 'auto-generated-components.ts'),
 *   importPrefix: '@app/server/live',
 * })
 * ```
 */
export function generateLiveComponentsFile(options: GenerateLiveComponentsOptions): number {
  const {
    componentsDir,
    outFile = join(componentsDir, 'auto-generated-components.ts'),
    importPrefix,
  } = options

  // Compute the import path for each component
  // When outFile is in a different directory (e.g. inside the lib's temp/),
  // calculate relative path from outFile back to componentsDir
  const outDir = dirname(outFile)
  const resolveImport = importPrefix
    ? (fileName: string) => `${importPrefix}/${fileName}`
    : (fileName: string) => {
        const rel = relative(outDir, componentsDir).replace(/\\/g, '/')
        const prefix = rel === '' ? '.' : rel
        return `${prefix}/${fileName}`
      }

  if (!existsSync(componentsDir)) return -1

  const components: { className: string; fileName: string }[] = []

  for (const file of readdirSync(componentsDir)) {
    if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue

    const content = readFileSync(join(componentsDir, file), 'utf-8')
    const matches = content.matchAll(/export\s+class\s+(\w+)\s+extends\s+LiveComponent/g)

    for (const match of matches) {
      components.push({
        className: match[1],
        fileName: basename(file, extname(file)),
      })
    }
  }

  components.sort((a, b) => a.className.localeCompare(b.className))

  const imports = components
    .map(c => `import { ${c.className} } from "${resolveImport(c.fileName)}"`)
    .join('\n')

  const entries = components.map(c => `  ${c.className},`).join('\n')

  const generated = `// Auto-generated Live Components Registration
// Generated by @fluxstack/live — DO NOT EDIT MANUALLY
// Generated at: ${new Date().toISOString()}

${imports}

// Component classes array for LiveServer({ components }) option
export const liveComponentClasses = [
${entries}
]
`
  // Only write if the component list changed — avoids triggering hot-reload loops in dev
  if (existsSync(outFile)) {
    const existing = readFileSync(outFile, 'utf-8')
    // Compare ignoring the timestamp line
    const strip = (s: string) => s.replace(/^\/\/ Generated at:.*$/m, '')
    if (strip(existing) === strip(generated)) return components.length
  }

  // Ensure output directory exists
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

  writeFileSync(outFile, generated)
  return components.length
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

// ===== Internals exposed for testing =====
// Not part of the public API. Subject to change without notice.
export const _internals = { extractMeta, extractDefaultState, stripAsCasts, buildStub }

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
  let isMultiEnvBuild = false
  const nameToFile = new Map<string, string>()
  const fileToName = new Map<string, string>()
  const cache = new Map<string, string>()

  const log = verbose ? (msg: string) => console.log(`[live-strip] ${msg}`) : () => {}

  function writeStub(name: string, serverPath: string): string {
    const stubPath = join(stubDir, `${name}.js`)
    const content = buildStub(extractMeta(serverPath))
    if (cache.get(name) !== content) {
      // Garante o diretório antes de escrever. No build RSC multi-ambiente,
      // configResolved roda por ambiente e o stubDir pode não ter sido criado
      // no contexto atual — sem isto, writeFileSync falha com ENOENT.
      if (!existsSync(stubDir)) mkdirSync(stubDir, { recursive: true })
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
      // stubDir ANCORADO no config.root do client (estável). No build RSC há
      // múltiplos ambientes (rsc/ssr/client) com config.root DIFERENTES — se o
      // stubDir variar, um ambiente escreve o stub e outro não o acha (ENOENT).
      // Detecta o client root: se config.root já aponta pro client (tem index.html
      // ou /src), usa ele; senão deriva do projectRoot + clientDir.
      const clientRoot = config.root.replace(/[\\/]+$/, '').endsWith('client')
        ? config.root
        : join(projectRoot, 'app', 'client')
      stubDir = join(clientRoot, stubDirName)
      if (!existsSync(stubDir)) mkdirSync(stubDir, { recursive: true })

      // Detecta build RSC multi-ambiente: o plugin-rsc registra os ambientes
      // 'rsc' e 'ssr' além do client. Se existirem, o cleanup dos stubs no
      // buildEnd (que roda por ambiente) apagaria stubs que outro ambiente ainda
      // vai ler — então só limpamos em build single-env (SPA).
      const envs = (config as { environments?: Record<string, unknown> }).environments ?? {}
      isMultiEnvBuild = !!(envs.rsc || envs.ssr)
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
      // Em build RSC multi-ambiente, NÃO apagar os stubs aqui: cada ambiente
      // (rsc/ssr/client) tem seu próprio buildEnd, e apagar num faz o próximo
      // falhar com ENOENT ao lê-los. Stubs são temporários (.live-stubs, gitignored).
      // Só limpamos em build single-env (SPA).
      if (!isMultiEnvBuild && existsSync(stubDir)) {
        rmSync(stubDir, { recursive: true, force: true })
      }
    },
  }
}
