// PluginManager: ciclo de vida (initialize → setup, registerPlugin tardio,
// shutdown → onServerStop), dispatch de hooks (ordem, isolamento de erro,
// stopOnError, enabled/disabled, timeout, retry, paralelo), eventos, métricas
// e as fábricas de contexto.
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  PluginManager,
  createRequestContext,
  createResponseContext,
  createErrorContext,
  createBuildContext,
} from '../runtime/manager'
import type { PluginRegistrySettings } from '../runtime/registry'
import type { PluginContext, PluginMetrics } from '../types'
import { memoryLogger, plugin } from './helpers'

interface AppConfig { port: number }

function makeManager(settings: PluginRegistrySettings = {}) {
  const logger = memoryLogger()
  const clientHooks = { register: vi.fn() }
  const app = { kind: 'fake-app' }
  const manager = new PluginManager<AppConfig>({ config: { port: 3000 }, settings, logger, clientHooks, app })
  return { manager, logger, clientHooks, app }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('PluginManager — ciclo de vida', () => {
  it('initialize roda setup em ordem de carga com o PluginContext completo', async () => {
    const { manager, logger, clientHooks, app } = makeManager()
    const calls: string[] = []
    let received: PluginContext<AppConfig> | undefined
    manager.getRegistry().registerSync(plugin('late', { priority: 'low', setup: () => { calls.push('late') } }))
    manager.getRegistry().registerSync(plugin('first', {
      priority: 'highest',
      setup: (ctx: PluginContext<unknown>) => { calls.push('first'); received = ctx as PluginContext<AppConfig> },
    }))
    manager.getRegistry().registerSync(plugin('dep', { priority: 'lowest', setup: () => { calls.push('dep') } }))
    manager.getRegistry().registerSync(plugin('needs-dep', { priority: 'highest', dependencies: ['dep'], setup: () => { calls.push('needs-dep') } }))

    await manager.initialize()

    expect(calls).toEqual(['first', 'late', 'dep', 'needs-dep'])
    expect(received!.config).toEqual({ port: 3000 })
    expect(received!.app).toBe(app)
    expect(received!.clientHooks).toBe(clientHooks)
    expect(received!.registry).toBe(manager.getRegistry())
    expect(typeof received!.utils.formatBytes).toBe('function')
    // logger filho por plugin
    expect(logger.childContexts).toContainEqual({ plugin: 'first' })
  })

  it('initialize é idempotente', async () => {
    const { manager } = makeManager()
    const setup = vi.fn()
    manager.getRegistry().registerSync(plugin('a', { setup }))
    await manager.initialize()
    await manager.initialize()
    expect(setup).toHaveBeenCalledTimes(1)
  })

  it('registerPlugin depois do initialize roda o setup na hora', async () => {
    const { manager } = makeManager()
    await manager.initialize()
    const setup = vi.fn()
    await manager.registerPlugin(plugin('tardio', { setup }))
    expect(setup).toHaveBeenCalledTimes(1)
    expect(manager.getRegistry().has('tardio')).toBe(true)
  })

  it('registerPlugin antes do initialize adia o setup', async () => {
    const { manager } = makeManager()
    const setup = vi.fn()
    await manager.registerPlugin(plugin('cedo', { setup }))
    expect(setup).not.toHaveBeenCalled()
    await manager.initialize()
    expect(setup).toHaveBeenCalledTimes(1)
  })

  it('registerPlugin respeita a whitelist npm', async () => {
    const { manager } = makeManager({ allowedPlugins: [] })
    await expect(manager.registerPlugin(plugin('@evil/fluxstack-plugin-x'))).rejects.toMatchObject({ code: 'PLUGIN_NOT_WHITELISTED' })
  })

  it('shutdown roda onServerStop só se inicializado', async () => {
    const { manager } = makeManager()
    const stop = vi.fn()
    manager.getRegistry().registerSync(plugin('a', { onServerStop: stop }))
    await manager.shutdown()
    expect(stop).not.toHaveBeenCalled()

    await manager.initialize()
    await manager.shutdown()
    expect(stop).toHaveBeenCalledTimes(1)
    expect(stop.mock.calls[0][0]).toHaveProperty('config', { port: 3000 })

    await manager.shutdown() // já desligado
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('setup que falha não impede os outros nem o initialize', async () => {
    const { manager } = makeManager()
    const ok = vi.fn()
    manager.getRegistry().registerSync(plugin('boom', { priority: 'highest', setup: () => { throw new Error('setup quebrou') } }))
    manager.getRegistry().registerSync(plugin('ok', { setup: ok }))
    await expect(manager.initialize()).resolves.toBeUndefined()
    expect(ok).toHaveBeenCalled()
    expect((manager.getPluginMetrics('boom') as PluginMetrics).errors).toBe(1)
  })

  it('unregisterPlugin remove plugin, contexto e métricas', async () => {
    const { manager } = makeManager()
    await manager.registerPlugin(plugin('a', { setup: vi.fn() }))
    await manager.unregisterPlugin('a')
    expect(manager.getRegistry().has('a')).toBe(false)
    expect((manager.getPluginMetrics() as Map<string, PluginMetrics>).has('a')).toBe(false)
  })

  it('unregisterPlugin propaga o erro do registry e não apaga o contexto de quem continua registrado', async () => {
    const { manager } = makeManager()
    await manager.registerPlugin(plugin('db', { onRequest: vi.fn() }))
    await manager.registerPlugin(plugin('api', { dependencies: ['db'] }))

    await expect(manager.unregisterPlugin('db')).rejects.toMatchObject({ code: 'PLUGIN_HAS_DEPENDENTS' })
    await expect(manager.unregisterPlugin('ghost')).rejects.toMatchObject({ code: 'PLUGIN_NOT_FOUND' })

    // "db" continua registrado e funcional (contexto intacto)
    const [res] = await manager.executeHook('onRequest', {})
    expect(res).toMatchObject({ plugin: 'db', success: true })
  })
})

describe('PluginManager — executeHook', () => {
  it('erro num plugin não derruba os outros (contrato padrão)', async () => {
    const { manager } = makeManager()
    const after = vi.fn()
    manager.getRegistry().registerSync(plugin('a', { priority: 'highest', onRequest: () => { throw new Error('a falhou') } }))
    manager.getRegistry().registerSync(plugin('b', { onRequest: after }))
    await manager.initialize()
    const errors: unknown[] = []
    manager.on('plugin:error', (e) => errors.push(e))

    const results = await manager.executeHook('onRequest', { path: '/' })
    expect(results.map((r) => [r.plugin, r.success])).toEqual([['a', false], ['b', true]])
    expect(results[0].error?.message).toBe('a falhou')
    expect(after).toHaveBeenCalledWith({ path: '/' })
    expect(errors).toEqual([expect.objectContaining({ plugin: 'a', hook: 'onRequest' })])
  })

  it('stopOnError interrompe na primeira falha', async () => {
    const { manager } = makeManager()
    const after = vi.fn()
    manager.getRegistry().registerSync(plugin('a', { priority: 'highest', onRequest: () => { throw new Error('x') } }))
    manager.getRegistry().registerSync(plugin('b', { onRequest: after }))
    await manager.initialize()
    const results = await manager.executeHook('onRequest', {}, { stopOnError: true })
    expect(results).toHaveLength(1)
    expect(after).not.toHaveBeenCalled()
  })

  it('plugins sem o hook contam como sucesso de duração 0', async () => {
    const { manager } = makeManager()
    manager.getRegistry().registerSync(plugin('vazio'))
    await manager.initialize()
    expect(await manager.executeHook('onBuild', {})).toEqual([{ success: true, duration: 0, plugin: 'vazio', hook: 'onBuild' }])
  })

  it('enabled / disabled filtram quem executa', async () => {
    const { manager } = makeManager({ enabled: ['a', 'b'], disabled: ['b'] })
    const a = vi.fn(), b = vi.fn(), c = vi.fn()
    manager.getRegistry().registerSync(plugin('a', { onResponse: a }))
    manager.getRegistry().registerSync(plugin('b', { onResponse: b }))
    manager.getRegistry().registerSync(plugin('c', { onResponse: c }))
    await manager.initialize()
    await manager.executeHook('onResponse', {})
    expect(a).toHaveBeenCalled()
    expect(b).not.toHaveBeenCalled() // disabled vence enabled
    expect(c).not.toHaveBeenCalled() // fora de enabled
  })

  it('contexto por hook: lifecycle recebe PluginContext; pipeline recebe o contexto passado; demais usam contexto ?? PluginContext', async () => {
    const { manager } = makeManager()
    const seen: Record<string, unknown> = {}
    manager.getRegistry().registerSync(plugin('p', {
      onServerStart: (c: unknown) => { seen.onServerStart = c },
      onError: (c: unknown) => { seen.onError = c },
      onBuildComplete: (c: unknown) => { seen.onBuildComplete = c },
      onBeforeRoute: (c: unknown) => { seen.onBeforeRoute = c },
      onConfigLoad: (c: unknown) => { seen.onConfigLoad = c },
    }))
    await manager.initialize()
    await manager.executeHook('onServerStart', { ignorado: true })
    await manager.executeHook('onError', { erro: 1 })
    await manager.executeHook('onBuildComplete', { build: 1 })
    await manager.executeHook('onBeforeRoute', { rota: 1 })
    await manager.executeHook('onConfigLoad')

    expect(seen.onServerStart).toHaveProperty('config', { port: 3000 })
    expect(seen.onError).toEqual({ erro: 1 })
    expect(seen.onBuildComplete).toEqual({ build: 1 })
    expect(seen.onBeforeRoute).toEqual({ rota: 1 })
    expect(seen.onConfigLoad).toHaveProperty('config', { port: 3000 })
  })

  it('timeout: hook lento vira falha PLUGIN_TIMEOUT', async () => {
    const { manager } = makeManager()
    manager.getRegistry().registerSync(plugin('lento', { onRequest: () => new Promise((r) => setTimeout(r, 200)) }))
    await manager.initialize()
    const [res] = await manager.executeHook('onRequest', {}, { timeout: 20 })
    expect(res.success).toBe(false)
    expect(res.error).toMatchObject({ code: 'PLUGIN_TIMEOUT', statusCode: 408 })
  })

  it('retries: tenta de novo com backoff exponencial até dar certo', async () => {
    vi.useFakeTimers()
    const { manager } = makeManager()
    let attempts = 0
    manager.getRegistry().registerSync(plugin('instavel', {
      onRequest: () => {
        attempts++
        if (attempts < 3) throw new Error(`tentativa ${attempts}`)
      },
    }))
    await manager.initialize()
    const p = manager.executeHook('onRequest', {}, { retries: 2 })
    await vi.advanceTimersByTimeAsync(999)
    expect(attempts).toBe(1) // 1º backoff = 1000ms
    await vi.advanceTimersByTimeAsync(1)
    expect(attempts).toBe(2)
    await vi.advanceTimersByTimeAsync(2000) // 2º backoff = 2000ms
    const [res] = await p
    expect(attempts).toBe(3)
    expect(res.success).toBe(true)
  })

  it('retries esgotados → falha com o último erro', async () => {
    vi.useFakeTimers()
    const { manager } = makeManager()
    let attempts = 0
    manager.getRegistry().registerSync(plugin('sempre-falha', { onRequest: () => { attempts++; throw new Error(`erro ${attempts}`) } }))
    await manager.initialize()
    const p = manager.executeHook('onRequest', {}, { retries: 1 })
    await vi.advanceTimersByTimeAsync(1000)
    const [res] = await p
    expect(attempts).toBe(2)
    expect(res).toMatchObject({ success: false })
    expect(res.error?.message).toBe('erro 2')
  })

  it('parallel: roda todos juntos e junta resultados', async () => {
    const { manager } = makeManager()
    let running = 0
    let max = 0
    const slow = async () => {
      running++
      max = Math.max(max, running)
      await new Promise((r) => setTimeout(r, 10))
      running--
    }
    for (const n of ['a', 'b', 'c']) manager.getRegistry().registerSync(plugin(n, { onBuild: slow }))
    await manager.initialize()
    const results = await manager.executeHook('onBuild', {}, { parallel: true })
    expect(max).toBe(3)
    expect(results.every((r) => r.success)).toBe(true)
  })

  it('emite hook:before por plugin e hook:after por execução', async () => {
    const { manager } = makeManager()
    manager.getRegistry().registerSync(plugin('a', { onRequest: vi.fn() }))
    manager.getRegistry().registerSync(plugin('b', { onRequest: vi.fn() }))
    await manager.initialize()
    const before: string[] = []
    const after: unknown[] = []
    manager.on('hook:before', (e: { plugin: string }) => before.push(e.plugin))
    manager.on('hook:after', (e) => after.push(e))
    await manager.executeHook('onRequest', { x: 1 })
    expect(before).toEqual(['a', 'b'])
    expect(after).toEqual([expect.objectContaining({ hook: 'onRequest', context: { x: 1 } })])
  })

  it('métricas: contagem por hook, setupTime, erros e lastExecution', async () => {
    const { manager } = makeManager()
    let fail = false
    manager.getRegistry().registerSync(plugin('m', { setup: vi.fn(), onRequest: () => { if (fail) throw new Error('x') } }))
    await manager.initialize()
    await manager.executeHook('onRequest', {})
    fail = true
    await manager.executeHook('onRequest', {})

    const m = manager.getPluginMetrics('m') as PluginMetrics
    expect(m.hookExecutions.get('setup')).toBe(1)
    expect(m.hookExecutions.get('onRequest')).toBe(2)
    expect(m.errors).toBe(1)
    expect(m.lastExecution).toBeInstanceOf(Date)

    const unknown = manager.getPluginMetrics('nao-existe') as PluginMetrics
    expect(unknown).toMatchObject({ errors: 0, setupTime: 0 })
  })

  it('executePluginHook sem contexto configurado falha com PLUGIN_CONTEXT_NOT_FOUND', async () => {
    const { manager } = makeManager()
    // plugin fora do registry → não tem contexto
    const res = await manager.executePluginHook(plugin('solto', { setup: vi.fn() }), 'setup')
    expect(res.success).toBe(false)
    expect(res.error).toMatchObject({ code: 'PLUGIN_CONTEXT_NOT_FOUND' })
  })
})

describe('fábricas de contexto', () => {
  it('createRequestContext extrai path, método, headers e query', () => {
    const req = new Request('http://app.test/api/users?page=2&q=ana', { method: 'POST', headers: { 'x-trace': 't1' } })
    const ctx = createRequestContext(req, { user: 'u1' })
    expect(ctx).toMatchObject({ path: '/api/users', method: 'POST', query: { page: '2', q: 'ana' }, params: {}, user: 'u1' })
    expect(ctx.headers['x-trace']).toBe('t1')
    expect(typeof ctx.startTime).toBe('number')
  })

  it('createResponseContext calcula status, tamanho e duração', () => {
    const reqCtx = createRequestContext(new Request('http://app.test/'))
    const res = new Response('ok', { status: 201, headers: { 'content-length': '2' } })
    const ctx = createResponseContext(reqCtx, res)
    expect(ctx).toMatchObject({ statusCode: 201, size: 2, response: res })
    expect(ctx.duration).toBeGreaterThanOrEqual(0)
  })

  it('createErrorContext marca handled=false', () => {
    const reqCtx = createRequestContext(new Request('http://app.test/'))
    const err = new Error('x')
    expect(createErrorContext(reqCtx, err)).toMatchObject({ error: err, handled: false })
  })

  it('createBuildContext', () => {
    expect(createBuildContext('bun', 'dist', 'production', { port: 1 })).toEqual({ target: 'bun', outDir: 'dist', mode: 'production', config: { port: 1 } })
  })
})
