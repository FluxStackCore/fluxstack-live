// Módulos de apoio do runtime: createPluginUtils, PluginModuleResolver,
// PluginDependencyManager (sem instalar nada: só caminhos que não chamam o
// gerenciador de pacotes) e PluginError.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { join } from 'path'
import { createPluginUtils } from '../runtime/utils'
import { PluginModuleResolver } from '../runtime/module-resolver'
import { PluginDependencyManager } from '../runtime/dependency-manager'
import { PluginError } from '../runtime/errors'
import * as barrel from '../index'
import { memoryLogger, tempDir } from './helpers'

let dir: ReturnType<typeof tempDir> | null = null
afterEach(() => {
  dir?.cleanup()
  dir = null
  vi.unstubAllEnvs()
})

describe('createPluginUtils', () => {
  const utils = createPluginUtils(memoryLogger())

  it('formatBytes', () => {
    expect(utils.formatBytes(0)).toBe('0 Bytes')
    expect(utils.formatBytes(512)).toBe('512 Bytes')
    expect(utils.formatBytes(1536)).toBe('1.5 KB')
    expect(utils.formatBytes(5 * 1024 * 1024)).toBe('5 MB')
  })

  it('createHash é determinístico e diferencia entradas', () => {
    expect(utils.createHash('abc')).toBe(utils.createHash('abc'))
    expect(utils.createHash('abc')).not.toBe(utils.createHash('abd'))
    expect(utils.createHash('')).toBe('0')
  })

  it('deepMerge: fonte vence, objetos aninhados mesclam, arrays substituem, não muta', () => {
    const target = { a: 1, nested: { x: 1, y: 2 }, list: [1, 2] }
    const merged = utils.deepMerge(target, { b: 2, nested: { y: 3, z: 4 }, list: [9] })
    expect(merged).toEqual({ a: 1, b: 2, nested: { x: 1, y: 3, z: 4 }, list: [9] })
    expect(target.nested).toEqual({ x: 1, y: 2 })
  })

  it('validateSchema checa campos obrigatórios', () => {
    const schema = { type: 'object' as const, properties: {}, required: ['url', 'token'] }
    expect(utils.validateSchema({ url: 'x', token: 'y' }, schema)).toEqual({ valid: true, errors: [] })
    expect(utils.validateSchema({ url: 'x' }, schema)).toEqual({ valid: false, errors: ['Missing required field: token'] })
    expect(utils.validateSchema({}, { type: 'object', properties: {} }).valid).toBe(true)
  })

  it('ambiente via NODE_ENV', () => {
    vi.stubEnv('NODE_ENV', 'production')
    expect(utils.isProduction()).toBe(true)
    expect(utils.isDevelopment()).toBe(false)
    expect(utils.getEnvironment()).toBe('production')
    vi.stubEnv('NODE_ENV', 'development')
    expect(utils.isDevelopment()).toBe(true)
  })

  it('createTimer mede e loga em debug', async () => {
    const logger = memoryLogger()
    const timer = createPluginUtils(logger).createTimer('carga')
    await new Promise((r) => setTimeout(r, 5))
    expect(timer.end()).toBeGreaterThanOrEqual(0)
    expect(logger.messages('debug')).toContain("Timer 'carga' completed")
  })

  it('funciona sem logger', () => {
    expect(() => createPluginUtils().createTimer('x').end()).not.toThrow()
  })
})

describe('PluginModuleResolver', () => {
  it('prefere node_modules do plugin; cai para o do projeto', () => {
    dir = tempDir({
      'project/node_modules/shared/package.json': JSON.stringify({ main: 'lib/main.js' }),
      'project/node_modules/shared/lib/main.js': '',
      'project/node_modules/both/index.js': '',
      'plugin/node_modules/both/package.json': JSON.stringify({ module: 'esm.js' }),
      'plugin/node_modules/both/esm.js': '',
    })
    const r = new PluginModuleResolver({ projectRoot: join(dir.root, 'project') })
    const pluginPath = join(dir.root, 'plugin')
    expect(r.resolveModule('both', pluginPath)).toBe(join(pluginPath, 'node_modules', 'both', 'esm.js'))
    expect(r.resolveModule('shared', pluginPath)).toBe(join(dir.root, 'project', 'node_modules', 'shared', 'lib', 'main.js'))
  })

  it('fallbacks: index.js, index.ts e o próprio diretório', () => {
    dir = tempDir({
      'p/node_modules/js-only/index.js': '',
      'p/node_modules/ts-only/index.ts': '',
      'p/node_modules/bare/README.md': '',
      'p/node_modules/bad-pkg/package.json': '{ inválido',
      'p/node_modules/bad-pkg/index.js': '',
    })
    const r = new PluginModuleResolver({ projectRoot: join(dir.root, 'nada') })
    const p = join(dir.root, 'p')
    expect(r.resolveModule('js-only', p)).toBe(join(p, 'node_modules', 'js-only', 'index.js'))
    expect(r.resolveModule('ts-only', p)).toBe(join(p, 'node_modules', 'ts-only', 'index.ts'))
    expect(r.resolveModule('bare', p)).toBe(join(p, 'node_modules', 'bare'))
    expect(r.resolveModule('bad-pkg', p)).toBe(join(p, 'node_modules', 'bad-pkg', 'index.js'))
  })

  it('não encontrado → null com warning', () => {
    dir = tempDir()
    const logger = memoryLogger()
    const r = new PluginModuleResolver({ projectRoot: dir.root, logger })
    expect(r.resolveModule('inexistente', dir.root)).toBeNull()
    expect(logger.messages('warn').some((m) => m.includes("'inexistente' not found"))).toBe(true)
  })

  it('resolveSubpath com extensão implícita e index', () => {
    dir = tempDir({
      'p/node_modules/@noble/curves/ed25519.js': '',
      'proj/node_modules/lib/sub/index.ts': '',
    })
    const r = new PluginModuleResolver({ projectRoot: join(dir.root, 'proj') })
    const p = join(dir.root, 'p')
    expect(r.resolveSubpath('@noble/curves', 'ed25519', p)).toBe(join(p, 'node_modules', '@noble/curves/ed25519') + '.js')
    expect(r.resolveSubpath('lib', 'sub', p)).toBe(join(dir.root, 'proj', 'node_modules', 'lib/sub'))
    expect(r.resolveSubpath('lib', 'nada', p)).toBeNull()
  })

  it('cache: segunda resolução não toca o disco; clearCache e getStats', () => {
    dir = tempDir({ 'p/node_modules/m/index.js': '' })
    const r = new PluginModuleResolver({ projectRoot: dir.root })
    const p = join(dir.root, 'p')
    const first = r.resolveModule('m', p)
    dir.cleanup() // apaga o arquivo: só o cache responde agora
    expect(r.resolveModule('m', p)).toBe(first)
    expect(r.getStats()).toEqual({ cachedModules: 1, projectRoot: dir.root })
    r.clearCache()
    expect(r.getStats().cachedModules).toBe(0)
    expect(r.resolveModule('m', p)).toBeNull()
  })
})

describe('PluginDependencyManager', () => {
  it('lê dependencies e peerDependencies (opcionais marcadas) do package.json', async () => {
    dir = tempDir({
      'plugins/auth/package.json': JSON.stringify({
        dependencies: { jose: '^5.0.0' },
        peerDependencies: { react: '^19.0.0', vue: '^3.0.0' },
        peerDependenciesMeta: { vue: { optional: true } },
      }),
    })
    const dm = new PluginDependencyManager({ workspaceRoot: dir.root, autoInstall: false })
    const res = await dm.resolvePluginDependencies(join(dir.root, 'plugins', 'auth'))
    expect(res.plugin).toBe('auth')
    expect(res.resolved).toBe(true)
    expect(res.dependencies).toEqual([
      { name: 'jose', version: '^5.0.0', type: 'dependency' },
      { name: 'react', version: '^19.0.0', type: 'peerDependency', optional: false },
      { name: 'vue', version: '^3.0.0', type: 'peerDependency', optional: true },
    ])
  })

  it('nome do plugin sai do último segmento do caminho (/ e \\)', async () => {
    const dm = new PluginDependencyManager({ workspaceRoot: '/nao/existe' })
    expect((await dm.resolvePluginDependencies('plugins/foo')).plugin).toBe('foo')
    expect((await dm.resolvePluginDependencies('C:\\app\\plugins\\bar')).plugin).toBe('bar')
    expect((await dm.resolvePluginDependencies('plugins/baz/')).plugin).toBe('baz')
  })

  it('sem package.json → resolvido sem dependências', async () => {
    dir = tempDir()
    const dm = new PluginDependencyManager({ workspaceRoot: dir.root })
    expect(await dm.resolvePluginDependencies(join(dir.root, 'x'))).toEqual({ plugin: 'x', dependencies: [], conflicts: [], resolved: true })
  })

  it('package.json corrompido → resolved:false', async () => {
    dir = tempDir({ 'p/package.json': '{ ruim' })
    const dm = new PluginDependencyManager({ workspaceRoot: dir.root })
    expect((await dm.resolvePluginDependencies(join(dir.root, 'p'))).resolved).toBe(false)
  })

  it('detecta conflito de versão entre plugins', async () => {
    dir = tempDir({
      'a/package.json': JSON.stringify({ dependencies: { lib: '2.0.0' } }),
      'b/package.json': JSON.stringify({ dependencies: { lib: '1.0.0' } }),
      'c/package.json': JSON.stringify({ dependencies: { lib: '^1.0.0' } }),
    })
    const dm = new PluginDependencyManager({ workspaceRoot: dir.root })
    await dm.resolvePluginDependencies(join(dir.root, 'a'))
    const b = await dm.resolvePluginDependencies(join(dir.root, 'b'))
    expect(b.resolved).toBe(false)
    expect(b.conflicts).toEqual([{ package: 'lib', versions: [{ plugin: 'a', version: '2.0.0' }, { plugin: 'b', version: '1.0.0' }] }])
    // ^1.0.0 aceita 2.0.0 e 1.0.0 (comparação simples >=)
    expect((await dm.resolvePluginDependencies(join(dir.root, 'c'))).resolved).toBe(true)
  })

  it('autoInstall: false não instala nada', async () => {
    const logger = memoryLogger()
    const dm = new PluginDependencyManager({ workspaceRoot: '/x', autoInstall: false, logger })
    await dm.installDependenciesInPath('/qualquer', { lib: '1.0.0' })
    await dm.installPluginDependencies([{ plugin: 'p', dependencies: [{ name: 'lib', version: '1', type: 'dependency' }], conflicts: [], resolved: true }])
    expect(logger.messages('debug').filter((m) => m.includes('Auto-install disabled'))).toHaveLength(2)
  })

  it('dependências já instaladas em versão compatível → não chama o gerenciador', async () => {
    dir = tempDir({ 'p/node_modules/lib/package.json': JSON.stringify({ version: '1.4.0' }) })
    const logger = memoryLogger()
    const dm = new PluginDependencyManager({ workspaceRoot: dir.root, logger })
    await dm.installPluginDependenciesLocally(join(dir.root, 'p'), [
      { name: 'lib', version: '^1.2.0', type: 'dependency' },
      { name: 'opcional', version: '1', type: 'peerDependency', optional: true },
    ])
    expect(logger.messages('debug')).toContain('✅ All plugin dependencies are already installed')
  })

  it('getStats reflete o package.json do workspace e as dependências registradas', () => {
    dir = tempDir({ 'package.json': JSON.stringify({ dependencies: { a: '1' }, devDependencies: { b: '1' } }) })
    const dm = new PluginDependencyManager({ workspaceRoot: dir.root, packageManager: 'npm' })
    dm.registerPluginDependencies('p', [{ name: 'x', version: '1', type: 'dependency' }, { name: 'y', version: '1', type: 'dependency' }])
    expect(dm.getStats()).toEqual({ totalPlugins: 1, totalDependencies: 2, installedDependencies: 2, packageManager: 'npm' })
  })
})

describe('PluginError e barrel', () => {
  it('carrega code/statusCode (default 500)', () => {
    const e = new PluginError('x', 'CODE')
    expect(e).toBeInstanceOf(Error)
    expect(e).toMatchObject({ name: 'PluginError', code: 'CODE', statusCode: 500, message: 'x' })
    expect(new PluginError('y', 'C', 404).statusCode).toBe(404)
  })

  it('index exporta o runtime e a versão', () => {
    expect(barrel.VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    for (const name of ['PluginManager', 'PluginRegistry', 'PluginDiscovery', 'PluginExecutor', 'PluginModuleResolver', 'PluginDependencyManager', 'PluginError', 'createPluginUtils', 'calculateExecutionStats', 'createRequestContext']) {
      expect(barrel).toHaveProperty(name)
    }
  })
})
