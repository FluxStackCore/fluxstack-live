// PluginDiscovery: varredura das 3 fontes (built-in, external, npm), resolução
// do arquivo de entrada, leitura de manifest e validações de compatibilidade.
import { describe, it, expect, afterEach } from 'vitest'
import { join } from 'path'
import { PluginDiscovery } from '../runtime/discovery'
import { memoryLogger, tempDir, pluginModule } from './helpers'

let dir: ReturnType<typeof tempDir> | null = null
afterEach(() => {
  dir?.cleanup()
  dir = null
})

const manifest = (name: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name, version: '1.0.0', dependencies: {}, fluxstack: { version: '1', hooks: [] }, ...extra })

describe('PluginDiscovery', () => {
  it('discoverAll varre built-in, external e npm (só fluxstack-plugin-*)', async () => {
    dir = tempDir({
      'core/plugins/built-in/logger/index.js': pluginModule('logger'),
      'plugins/meu/index.js': pluginModule('meu'),
      'node_modules/fluxstack-plugin-extra/index.js': pluginModule('fluxstack-plugin-extra'),
      'node_modules/outra-lib/index.js': pluginModule('outra-lib'),
    })
    const d = new PluginDiscovery({ baseDir: dir.root })
    const results = await d.discoverAll()
    expect(results.every((r) => r.success)).toBe(true)
    expect(results.map((r) => r.plugin!.name)).toEqual(['logger', 'meu', 'fluxstack-plugin-extra'])
  })

  it('opções includeBuiltIn / includeExternal filtram as fontes', async () => {
    dir = tempDir({
      'core/plugins/built-in/a/index.js': pluginModule('a'),
      'plugins/b/index.js': pluginModule('b'),
    })
    const d = new PluginDiscovery({ baseDir: dir.root })
    expect((await d.discoverAll({ includeExternal: false })).map((r) => r.plugin!.name)).toEqual(['a'])
    expect((await d.discoverAll({ includeBuiltIn: false })).map((r) => r.plugin!.name)).toEqual(['b'])
  })

  it('diretórios inexistentes resultam em lista vazia', async () => {
    dir = tempDir()
    const logger = memoryLogger()
    const d = new PluginDiscovery({ baseDir: dir.root, logger })
    expect(await d.discoverAll()).toEqual([])
    expect(logger.messages('debug').some((m) => m.includes('not found'))).toBe(true)
  })

  it('diretórios customizados sobrescrevem os padrões', async () => {
    dir = tempDir({ 'custom-ext/x/plugin.js': pluginModule('x') })
    const d = new PluginDiscovery({ baseDir: dir.root, externalDir: join(dir.root, 'custom-ext') })
    expect((await d.discoverExternalPlugins()).map((r) => r.plugin?.name)).toEqual(['x'])
  })

  it.each([
    ['index.js', 'index.js'],
    ['plugin.js', 'plugin.js'],
    ['src/index.js', 'src/index.js'],
    ['dist/index.js', 'dist/index.js'],
  ])('resolve entrada %s', async (_label, file) => {
    dir = tempDir({ [`plugins/p/${file}`]: pluginModule(`via-${file}`) })
    const d = new PluginDiscovery({ baseDir: dir.root })
    const [r] = await d.discoverExternalPlugins()
    expect(r).toMatchObject({ success: true, plugin: { name: `via-${file}` } })
  })

  it('index tem precedência sobre plugin e src/index', async () => {
    dir = tempDir({
      'plugins/p/index.js': pluginModule('do-index'),
      'plugins/p/plugin.js': pluginModule('do-plugin'),
      'plugins/p/src/index.js': pluginModule('do-src'),
    })
    const [r] = await new PluginDiscovery({ baseDir: dir.root }).discoverExternalPlugins()
    expect(r.plugin!.name).toBe('do-index')
  })

  it('sem arquivo de entrada → falha explicando', async () => {
    dir = tempDir({ 'plugins/vazio/README.md': 'nada' })
    const [r] = await new PluginDiscovery({ baseDir: dir.root }).discoverExternalPlugins()
    expect(r).toMatchObject({ success: false, error: expect.stringMatching(/No plugin entry point/) })
  })

  it('plugin inválido: sem name ou hook que não é função', async () => {
    dir = tempDir({
      'plugins/sem-nome/index.js': 'export default { version: "1" }\n',
      'plugins/hook-ruim/index.js': 'export default { name: "hook-ruim", setup: "nao sou funcao" }\n',
    })
    const logger = memoryLogger()
    const results = await new PluginDiscovery({ baseDir: dir.root, logger }).discoverExternalPlugins()
    expect(results).toHaveLength(2)
    for (const r of results) expect(r).toMatchObject({ success: false, error: expect.stringMatching(/Invalid plugin/) })
    expect(logger.messages('warn').some((m) => m.includes('invalid hook "setup"'))).toBe(true)
  })

  it('aceita export nomeado (módulo sem default)', async () => {
    dir = tempDir({ 'plugins/n/index.js': 'export const name = "nomeado"\nexport function setup() {}\n' })
    const [r] = await new PluginDiscovery({ baseDir: dir.root }).discoverExternalPlugins()
    expect(r).toMatchObject({ success: true, plugin: { name: 'nomeado' } })
  })

  it('erro ao importar vira resultado de falha (não lança)', async () => {
    dir = tempDir({ 'plugins/quebrado/index.js': 'throw new Error("explodiu no import")\n' })
    const logger = memoryLogger()
    const [r] = await new PluginDiscovery({ baseDir: dir.root, logger }).discoverExternalPlugins()
    expect(r).toMatchObject({ success: false, error: expect.stringMatching(/explodiu no import/) })
    expect(logger.messages('error').length).toBeGreaterThan(0)
  })

  describe('manifest', () => {
    it('sem manifest → warning', async () => {
      dir = tempDir({ 'plugins/p/index.js': pluginModule('p') })
      const [r] = await new PluginDiscovery({ baseDir: dir.root }).discoverExternalPlugins()
      expect(r.warnings).toEqual(['No plugin manifest found'])
    })

    it('plugin.json compatível → sem warnings', async () => {
      dir = tempDir({
        'plugins/p/index.js': pluginModule('p', { version: '1.0.0' }),
        'plugins/p/plugin.json': manifest('p'),
      })
      const [r] = await new PluginDiscovery({ baseDir: dir.root }).discoverExternalPlugins()
      expect(r).toMatchObject({ success: true, warnings: [] })
    })

    it('package.json#fluxstack serve de manifest; sem o bloco é ignorado', async () => {
      dir = tempDir({
        'node_modules/fluxstack-plugin-a/index.js': pluginModule('fluxstack-plugin-a', { version: '2.0.0' }),
        'node_modules/fluxstack-plugin-a/package.json': JSON.stringify({ name: 'fluxstack-plugin-a', version: '2.0.0', fluxstack: { version: '1', hooks: [] } }),
        'node_modules/fluxstack-plugin-b/index.js': pluginModule('fluxstack-plugin-b'),
        'node_modules/fluxstack-plugin-b/package.json': JSON.stringify({ name: 'fluxstack-plugin-b', version: '1.0.0' }),
      })
      const results = await new PluginDiscovery({ baseDir: dir.root }).discoverNpmPlugins()
      const byName = Object.fromEntries(results.map((r) => [r.plugin!.name, r.warnings]))
      expect(byName['fluxstack-plugin-a']).toEqual([])
      expect(byName['fluxstack-plugin-b']).toEqual(['No plugin manifest found'])
    })

    it('divergência de nome e versão gera warnings', async () => {
      dir = tempDir({
        'plugins/p/index.js': pluginModule('nome-do-codigo', { version: '9.9.9' }),
        'plugins/p/plugin.json': manifest('nome-do-manifest'),
      })
      const [r] = await new PluginDiscovery({ baseDir: dir.root }).discoverExternalPlugins()
      expect(r.warnings).toEqual([
        "Plugin name mismatch: plugin exports 'nome-do-codigo' but manifest declares 'nome-do-manifest'",
        "Plugin version mismatch: plugin exports '9.9.9' but manifest declares '1.0.0'",
      ])
    })

    it('hook declarado no manifest e não implementado gera warning', async () => {
      dir = tempDir({
        'plugins/p/index.js': pluginModule('p', { hooks: ['setup'] }),
        'plugins/p/plugin.json': manifest('p', { fluxstack: { version: '1', hooks: ['setup', 'onRequest'] } }),
      })
      const [r] = await new PluginDiscovery({ baseDir: dir.root }).discoverExternalPlugins()
      expect(r.warnings).toEqual(["Plugin declares hook 'onRequest' in manifest but doesn't implement it"])
    })

    it('plugin.json sem bloco fluxstack não derruba o carregamento', async () => {
      dir = tempDir({
        'plugins/p/index.js': pluginModule('p', { dependencies: ['outro'] }),
        'plugins/p/plugin.json': JSON.stringify({ name: 'p', version: '1.0.0' }),
      })
      const [r] = await new PluginDiscovery({ baseDir: dir.root }).discoverExternalPlugins()
      expect(r).toMatchObject({ success: true, plugin: { name: 'p' } })
    })

    it('plugin.json corrompido é ignorado com warning de log', async () => {
      dir = tempDir({
        'plugins/p/index.js': pluginModule('p'),
        'plugins/p/plugin.json': '{ isto não é json',
      })
      const logger = memoryLogger()
      const [r] = await new PluginDiscovery({ baseDir: dir.root, logger }).discoverExternalPlugins()
      expect(r).toMatchObject({ success: true, warnings: ['No plugin manifest found'] })
      expect(logger.messages('warn').some((m) => m.includes('Failed to parse plugin manifest'))).toBe(true)
    })
  })

  describe('loadPlugin(name)', () => {
    it('procura em built-in → external → npm (prefixo fluxstack-plugin-)', async () => {
      dir = tempDir({
        'core/plugins/built-in/dup/index.js': pluginModule('dup-builtin'),
        'plugins/dup/index.js': pluginModule('dup-external'),
        'plugins/so-ext/index.js': pluginModule('so-ext'),
        'node_modules/fluxstack-plugin-npmzinho/index.js': pluginModule('fluxstack-plugin-npmzinho'),
      })
      const d = new PluginDiscovery({ baseDir: dir.root })
      expect((await d.loadPlugin('dup')).plugin!.name).toBe('dup-builtin')
      expect((await d.loadPlugin('so-ext')).plugin!.name).toBe('so-ext')
      expect((await d.loadPlugin('npmzinho')).plugin!.name).toBe('fluxstack-plugin-npmzinho')
    })

    it('não encontrado', async () => {
      dir = tempDir()
      const r = await new PluginDiscovery({ baseDir: dir.root }).loadPlugin('fantasma')
      expect(r).toEqual({ success: false, error: "Plugin 'fantasma' not found in any plugin directory" })
    })
  })
})
