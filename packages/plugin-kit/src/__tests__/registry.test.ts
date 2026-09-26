// PluginRegistry: registro, validação, ordem de carga (dependências +
// prioridade), ciclos, dependências ausentes, unregister, hooks de
// registro e descoberta (projeto / npm) a partir do filesystem.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { PluginRegistry } from '../runtime/registry'
import { PluginError } from '../runtime/errors'
import type { PluginManifest } from '../types'
import { memoryLogger, plugin, tempDir, pluginModule } from './helpers'

describe('PluginRegistry — registro e validação', () => {
  it('registra, consulta e lista plugins', async () => {
    const reg = new PluginRegistry()
    const a = plugin('a', { version: '1.0.0' })
    await reg.register(a)
    reg.registerSync(plugin('b'))

    expect(reg.has('a')).toBe(true)
    expect(reg.get('a')).toBe(a)
    expect(reg.get('nope')).toBeUndefined()
    expect(reg.getAll().map((p) => p.name)).toEqual(['a', 'b'])
    expect(reg.getPluginsMap().size).toBe(2)
    expect(reg.getStats()).toMatchObject({ totalPlugins: 2, loadOrder: 2, conflicts: 0 })
  })

  it('guarda o manifest quando informado', async () => {
    const reg = new PluginRegistry()
    const manifest = { name: 'a', version: '1.0.0' } as PluginManifest
    await reg.register(plugin('a'), manifest)
    expect(reg.getManifest('a')).toBe(manifest)
    expect(reg.getAllManifests()).toEqual([manifest])
  })

  it('recusa nome duplicado (sync e async)', async () => {
    const reg = new PluginRegistry()
    await reg.register(plugin('a'))
    await expect(reg.register(plugin('a'))).rejects.toMatchObject({ code: 'PLUGIN_ALREADY_REGISTERED', statusCode: 400 })
    expect(() => reg.registerSync(plugin('a'))).toThrow(/already registered/)
  })

  it.each([
    ['sem nome', { name: '' }, /valid name/],
    ['versão não-string', { name: 'x', version: 1 }, /version must be a string/],
    ['dependencies não-array', { name: 'x', dependencies: 'y' }, /dependencies must be an array/],
    ['prioridade inválida', { name: 'x', priority: 'urgent' }, /priority must be/],
  ])('valida estrutura: %s', async (_label, bad, re) => {
    const reg = new PluginRegistry()
    const err = await reg.register(bad as never).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PluginError)
    expect((err as PluginError).code).toBe('INVALID_PLUGIN_STRUCTURE')
    expect(String(err)).toMatch(re)
    expect(reg.getAll()).toHaveLength(0)
  })

  it('aceita prioridade numérica e nomeada', () => {
    const reg = new PluginRegistry()
    expect(() => reg.registerSync(plugin('n', { priority: 42 }))).not.toThrow()
    expect(() => reg.registerSync(plugin('s', { priority: 'highest' }))).not.toThrow()
  })
})

describe('PluginRegistry — ordem de carga', () => {
  it('ordena por prioridade (maior primeiro) sem dependências', () => {
    const reg = new PluginRegistry()
    reg.registerSync(plugin('low', { priority: 'low' }))
    reg.registerSync(plugin('default'))
    reg.registerSync(plugin('top', { priority: 'highest' }))
    reg.registerSync(plugin('num', { priority: 800 }))
    expect(reg.getLoadOrder()).toEqual(['top', 'num', 'default', 'low'])
  })

  it('dependência vem antes do dependente mesmo com prioridade menor', () => {
    const reg = new PluginRegistry()
    reg.registerSync(plugin('app', { priority: 'highest', dependencies: ['db'] }))
    reg.registerSync(plugin('db', { priority: 'lowest', dependencies: ['config'] }))
    reg.registerSync(plugin('config', { priority: 'lowest' }))
    reg.registerSync(plugin('other', { priority: 'high' }))
    const order = reg.getLoadOrder()
    expect(order.indexOf('config')).toBeLessThan(order.indexOf('db'))
    expect(order.indexOf('db')).toBeLessThan(order.indexOf('app'))
    // dentro do mesmo "nível" a prioridade decide
    expect(order.slice(0, 2)).toEqual(['other', 'config'])
  })

  it('getLoadOrder devolve cópia', () => {
    const reg = new PluginRegistry()
    reg.registerSync(plugin('a'))
    reg.getLoadOrder().push('hack')
    expect(reg.getLoadOrder()).toEqual(['a'])
  })

  it('dependência ainda não registrada não bloqueia a ordem', () => {
    const reg = new PluginRegistry()
    reg.registerSync(plugin('a', { dependencies: ['externo'] }))
    expect(reg.getLoadOrder()).toEqual(['a'])
  })

  it('ciclo de dependências lança CIRCULAR_DEPENDENCY', () => {
    const reg = new PluginRegistry()
    reg.registerSync(plugin('a', { dependencies: ['b'] }))
    let err: unknown
    try {
      reg.registerSync(plugin('b', { dependencies: ['a'] }))
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(PluginError)
    expect((err as PluginError).code).toBe('CIRCULAR_DEPENDENCY')
  })

  it('auto-dependência também é ciclo', () => {
    const reg = new PluginRegistry()
    expect(() => reg.registerSync(plugin('self', { dependencies: ['self'] }))).toThrow(/Circular dependency/)
  })

  it('refreshLoadOrder cai para ordem de inserção se o sort falhar', () => {
    const reg = new PluginRegistry()
    reg.registerSync(plugin('a', { dependencies: ['b'] }))
    try { reg.registerSync(plugin('b', { dependencies: ['a'] })) } catch { /* ciclo */ }
    // o plugin com ciclo ficou no mapa: refresh não lança e usa inserção
    expect(() => reg.refreshLoadOrder()).not.toThrow()
    expect(reg.getLoadOrder()).toEqual(['a', 'b'])
  })
})

describe('PluginRegistry — dependências e unregister', () => {
  it('validateDependencies acusa dependência ausente', () => {
    const logger = memoryLogger()
    const reg = new PluginRegistry({ logger })
    reg.registerSync(plugin('a', { dependencies: ['fantasma'] }))
    expect(() => reg.validateDependencies()).toThrow(/depends on 'fantasma' which is not registered/)
    expect(reg.getStats().conflicts).toBe(1)
    expect(logger.messages('error').join()).toMatch(/fantasma/)
  })

  it('validateDependencies passa quando tudo existe (e zera conflitos)', () => {
    const reg = new PluginRegistry()
    reg.registerSync(plugin('a', { dependencies: ['b'] }))
    expect(() => reg.validateDependencies()).toThrow()
    reg.registerSync(plugin('b'))
    expect(() => reg.validateDependencies()).not.toThrow()
    expect(reg.getStats().conflicts).toBe(0)
  })

  it('getDependencies / getDependents', () => {
    const reg = new PluginRegistry()
    reg.registerSync(plugin('db'))
    reg.registerSync(plugin('api', { dependencies: ['db'] }))
    reg.registerSync(plugin('jobs', { dependencies: ['db'] }))
    expect(reg.getDependencies('api')).toEqual(['db'])
    expect(reg.getDependencies('db')).toEqual([])
    expect(reg.getDependents('db').sort()).toEqual(['api', 'jobs'])
  })

  it('unregister recusa quem tem dependentes e remove quem não tem', async () => {
    const reg = new PluginRegistry()
    reg.registerSync(plugin('db'))
    reg.registerSync(plugin('api', { dependencies: ['db'] }))

    await expect(reg.unregister('db')).rejects.toMatchObject({ code: 'PLUGIN_HAS_DEPENDENTS' })
    await expect(reg.unregister('ghost')).rejects.toMatchObject({ code: 'PLUGIN_NOT_FOUND', statusCode: 404 })

    await reg.unregister('api')
    await reg.unregister('db')
    expect(reg.getAll()).toHaveLength(0)
    expect(reg.getLoadOrder()).toEqual([])
  })

  it('checkMissingDependencies compara com o package.json do cwd', () => {
    const reg = new PluginRegistry()
    // o cwd dos testes tem package.json com vitest em devDependencies
    const missing = reg.checkMissingDependencies({ vitest: '^3', 'pacote-que-nao-existe-xyz': '1' })
    expect(missing).toEqual(['pacote-que-nao-existe-xyz'])
  })
})

describe('PluginRegistry — hooks onPluginRegister / onPluginUnregister', () => {
  it('avisa todos os plugins (inclusive o novo) e isola falhas', async () => {
    const logger = memoryLogger()
    const reg = new PluginRegistry({ logger })
    const seen: string[] = []
    await reg.register(plugin('observer', {
      onPluginRegister: (ctx: { pluginName: string; pluginVersion?: string }) => { seen.push(`reg:${ctx.pluginName}@${ctx.pluginVersion ?? '-'}`) },
      onPluginUnregister: (ctx: { pluginName: string }) => { seen.push(`unreg:${ctx.pluginName}`) },
    }))
    await reg.register(plugin('broken', {
      onPluginRegister: () => { throw new Error('hook quebrado') },
    }))
    await reg.register(plugin('late', { version: '2.0.0' }))
    await reg.unregister('late')

    expect(seen).toEqual(['reg:observer@-', 'reg:broken@-', 'reg:late@2.0.0', 'unreg:late'])
    // falha do hook de "broken" só gera log, não impede os registros
    expect(reg.has('late')).toBe(false)
    expect(logger.messages('error').some((m) => m.includes("'broken' onPluginRegister hook failed"))).toBe(true)
  })

  it('registerSync não dispara hooks de registro', () => {
    const reg = new PluginRegistry()
    const calls: string[] = []
    reg.registerSync(plugin('obs', { onPluginRegister: (c: { pluginName: string }) => { calls.push(c.pluginName) } }))
    reg.registerSync(plugin('x'))
    expect(calls).toEqual([])
  })
})

describe('PluginRegistry — whitelist npm também no register() async', () => {
  it('register() bloqueia plugin npm fora da whitelist (mesmo contrato do registerSync)', async () => {
    const reg = new PluginRegistry({ settings: { allowedPlugins: [] } })
    await expect(reg.register(plugin('@acme/fplugin-evil'))).rejects.toMatchObject({ code: 'PLUGIN_NOT_WHITELISTED', statusCode: 403 })
    expect(reg.has('@acme/fplugin-evil')).toBe(false)
  })

  it('register() permite npm na whitelist e projeto sempre', async () => {
    const reg = new PluginRegistry({ settings: { allowedPlugins: ['fluxstack-plugin-ok'] } })
    await reg.register(plugin('fluxstack-plugin-ok'))
    await reg.register(plugin('meu-plugin-local'))
    expect(reg.getAll()).toHaveLength(2)
  })
})

describe('PluginRegistry — descoberta no filesystem', () => {
  let cwd: string
  let dir: ReturnType<typeof tempDir> | null = null

  beforeEach(() => { cwd = process.cwd() })
  afterEach(() => {
    process.chdir(cwd)
    dir?.cleanup()
    dir = null
  })

  it('loadPlugin importa o módulo, lê plugin.json e registra', async () => {
    dir = tempDir({
      'p/index.js': pluginModule('from-disk', { version: '1.2.3', hooks: ['setup'] }),
      'p/plugin.json': JSON.stringify({ name: 'from-disk', version: '1.2.3', dependencies: {}, fluxstack: { version: '1', hooks: ['setup'] } }),
    })
    const reg = new PluginRegistry()
    const res = await reg.loadPlugin(`${dir.root}/p`)
    expect(res).toMatchObject({ success: true, warnings: [] })
    expect(reg.has('from-disk')).toBe(true)
    expect(reg.getManifest('from-disk')?.version).toBe('1.2.3')
  })

  it('loadPlugin sem manifest avisa; módulo sem name falha', async () => {
    dir = tempDir({
      'ok/index.js': pluginModule('sem-manifest'),
      'bad/index.js': 'export default { version: "1" }\n',
    })
    const reg = new PluginRegistry()
    expect(await reg.loadPlugin(`${dir.root}/ok`)).toMatchObject({ success: true, warnings: ['No plugin manifest found'] })
    expect(await reg.loadPlugin(`${dir.root}/bad`)).toMatchObject({ success: false, error: expect.stringMatching(/must export a plugin object/) })
  })

  it('discoverPlugins respeita discoverProjectPlugins=false', async () => {
    const reg = new PluginRegistry({ settings: {} })
    expect(await reg.discoverPlugins()).toEqual([])
  })

  it('discoverPlugins carrega plugins de plugins/ (relativo ao cwd)', async () => {
    dir = tempDir({
      'plugins/alpha/index.js': pluginModule('alpha'),
      'plugins/beta/plugin.js': pluginModule('beta', { dependencies: ['alpha'] }),
      'plugins/sem-entry/README.md': '# nada',
    })
    process.chdir(dir.root)
    const logger = memoryLogger()
    const reg = new PluginRegistry({ logger, settings: { discoverProjectPlugins: true } })
    const results = await reg.discoverPlugins({ directories: ['plugins', 'nao-existe'] })

    expect(results.filter((r) => r.success).map((r) => r.plugin!.name).sort()).toEqual(['alpha', 'beta'])
    expect(reg.getLoadOrder()).toEqual(['alpha', 'beta'])
    expect(logger.messages('warn').some((m) => m.includes('Directory does not exist: nao-existe'))).toBe(true)
  })

  it('discoverNpmPlugins: exige manifest fluxstack + whitelist; ignora plugin-kit', async () => {
    dir = tempDir({
      // plugin legítimo e liberado
      'node_modules/fluxstack-plugin-good/package.json': JSON.stringify({ name: 'fluxstack-plugin-good', version: '1.0.0', fluxstack: { version: '1', hooks: [] } }),
      'node_modules/fluxstack-plugin-good/index.js': pluginModule('fluxstack-plugin-good'),
      // plugin com manifest mas fora da whitelist
      'node_modules/fplugin-blocked/package.json': JSON.stringify({ name: 'fplugin-blocked', version: '1.0.0', fluxstack: { version: '1', hooks: [] } }),
      'node_modules/fplugin-blocked/index.js': pluginModule('fplugin-blocked'),
      // biblioteca com o prefixo mas sem bloco fluxstack → ignorada em silêncio
      'node_modules/@fluxstack/plugin-crypto-lib/package.json': JSON.stringify({ name: '@fluxstack/plugin-crypto-lib', version: '1.0.0' }),
      'node_modules/@fluxstack/plugin-crypto-lib/index.js': 'export const x = 1\n',
      // o próprio plugin-kit nunca é plugin
      'node_modules/@fluxstack/plugin-kit/package.json': JSON.stringify({ name: '@fluxstack/plugin-kit', version: '0.4.0', fluxstack: { version: '1', hooks: [] } }),
      // scoped liberado
      'node_modules/@acme/fluxstack-plugin-pay/package.json': JSON.stringify({ name: '@acme/fluxstack-plugin-pay', version: '1.0.0', fluxstack: { version: '1', hooks: [] } }),
      'node_modules/@acme/fluxstack-plugin-pay/index.js': pluginModule('@acme/fluxstack-plugin-pay'),
      // pacote qualquer
      'node_modules/lodash/package.json': JSON.stringify({ name: 'lodash' }),
    })
    process.chdir(dir.root)
    const logger = memoryLogger()
    const reg = new PluginRegistry({
      logger,
      settings: { discoverNpmPlugins: true, allowedPlugins: ['fluxstack-plugin-good', '@acme/fluxstack-plugin-pay'] },
    })
    const results = await reg.discoverNpmPlugins()

    expect(reg.getAll().map((p) => p.name).sort()).toEqual(['@acme/fluxstack-plugin-pay', 'fluxstack-plugin-good'])
    const blocked = results.filter((r) => !r.success)
    expect(blocked).toHaveLength(1)
    expect(blocked[0].error).toMatch(/fplugin-blocked.*whitelist/)
    expect(reg.has('@fluxstack/plugin-kit')).toBe(false)
    expect(logger.messages('warn').some((m) => m.includes('Blocked 1 npm plugin'))).toBe(true)
  })

  it('discoverNpmPlugins com whitelist vazia bloqueia tudo', async () => {
    dir = tempDir({
      'node_modules/fluxstack-plugin-x/package.json': JSON.stringify({ name: 'fluxstack-plugin-x', version: '1.0.0', fluxstack: { version: '1', hooks: [] } }),
      'node_modules/fluxstack-plugin-x/index.js': pluginModule('fluxstack-plugin-x'),
    })
    process.chdir(dir.root)
    const reg = new PluginRegistry({ settings: { discoverNpmPlugins: true } })
    const results = await reg.discoverNpmPlugins()
    expect(results).toEqual([{ success: false, error: expect.stringMatching(/not in the allowed plugins whitelist/) }])
    expect(reg.getAll()).toHaveLength(0)
  })

  it('discoverNpmPlugins desligado ou sem node_modules devolve []', async () => {
    dir = tempDir()
    process.chdir(dir.root)
    expect(await new PluginRegistry({ settings: {} }).discoverNpmPlugins()).toEqual([])
    expect(await new PluginRegistry({ settings: { discoverNpmPlugins: true } }).discoverNpmPlugins()).toEqual([])
  })
})
