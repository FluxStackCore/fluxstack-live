// PluginExecutor: plano de execução (filtro por hook, prioridade, ordem
// topológica, ciclos), validação, execução sequencial/paralela e estatísticas.
import { describe, it, expect } from 'vitest'
import { PluginExecutor, calculateExecutionStats } from '../runtime/executor'
import { PluginError } from '../runtime/errors'
import type { PluginHook, PluginHookResult } from '../types'
import type { Plugin } from '../types/plugin'
import { memoryLogger, plugin } from './helpers'

const noop = () => {}
const names = (steps: { plugin: Plugin }[]) => steps.map((s) => s.plugin.name)

function okResult(p: Plugin, hook: PluginHook, duration = 1): PluginHookResult {
  return { success: true, duration, plugin: p.name, hook }
}

describe('PluginExecutor.createExecutionPlan', () => {
  const executor = new PluginExecutor(memoryLogger())

  it('só inclui plugins que implementam o hook', () => {
    const plan = executor.createExecutionPlan(
      [plugin('a', { onRequest: noop }), plugin('b'), plugin('c', { onRequest: 'não é função' } as never)],
      'onRequest',
    )
    expect(names(plan.plugins)).toEqual(['a'])
    expect(plan).toMatchObject({ hook: 'onRequest', totalPlugins: 1, parallel: false })
  })

  it('ordena por prioridade (numérica e nomeada; padrão = normal/500)', () => {
    const plan = executor.createExecutionPlan(
      [
        plugin('lowest', { setup: noop, priority: 'lowest' }),
        plugin('default', { setup: noop }),
        plugin('n900', { setup: noop, priority: 900 }),
        plugin('high', { setup: noop, priority: 'high' }),
        plugin('low', { setup: noop, priority: 'low' }),
      ],
      'setup',
    )
    expect(names(plan.plugins)).toEqual(['n900', 'high', 'default', 'low', 'lowest'])
    expect(plan.plugins.map((s) => s.priority)).toEqual([900, 750, 500, 250, 0])
  })

  it('dependência roda antes do dependente mesmo com prioridade menor', () => {
    const plan = executor.createExecutionPlan(
      [
        plugin('app', { setup: noop, priority: 'highest', dependencies: ['db'] }),
        plugin('db', { setup: noop, priority: 'lowest' }),
      ],
      'setup',
    )
    expect(names(plan.plugins)).toEqual(['db', 'app'])
    const [db, app] = plan.plugins
    expect(db.dependents).toEqual(['app'])
    expect(app.dependencies).toEqual(['db'])
    expect(db.canExecuteInParallel).toBe(true)
    expect(app.canExecuteInParallel).toBe(false)
  })

  it('ciclo lança CIRCULAR_DEPENDENCY citando o hook', () => {
    let err: unknown
    try {
      executor.createExecutionPlan(
        [plugin('a', { setup: noop, dependencies: ['b'] }), plugin('b', { setup: noop, dependencies: ['a'] })],
        'setup',
      )
    } catch (e) { err = e }
    expect(err).toBeInstanceOf(PluginError)
    expect((err as PluginError).code).toBe('CIRCULAR_DEPENDENCY')
    expect(String(err)).toMatch(/for hook 'setup'/)
  })

  it("dependência que não implementa o hook não entra na ordenação", () => {
    const plan = executor.createExecutionPlan(
      [plugin('a', { onBuild: noop, dependencies: ['b'] }), plugin('b')],
      'onBuild',
    )
    expect(names(plan.plugins)).toEqual(['a'])
  })
})

describe('PluginExecutor.validateExecutionPlan', () => {
  const executor = new PluginExecutor(memoryLogger())

  it('plano saudável é válido', () => {
    const plan = executor.createExecutionPlan([plugin('a', { setup: noop }), plugin('b', { setup: noop, dependencies: ['a'] })], 'setup')
    expect(executor.validateExecutionPlan(plan)).toEqual({ valid: true, errors: [] })
  })

  it('acusa dependência ausente no plano', () => {
    const plan = executor.createExecutionPlan([plugin('a', { setup: noop, dependencies: ['fantasma'] })], 'setup')
    const res = executor.validateExecutionPlan(plan)
    expect(res.valid).toBe(false)
    expect(res.errors).toEqual(["Plugin 'a' depends on 'fantasma' which is not available"])
  })

  it('acusa ciclo num plano montado à mão', () => {
    const a = plugin('a', { setup: noop })
    const b = plugin('b', { setup: noop })
    const res = executor.validateExecutionPlan({
      hook: 'setup',
      parallel: false,
      totalPlugins: 2,
      plugins: [
        { plugin: a, priority: 500, dependencies: ['b'], dependents: ['b'], canExecuteInParallel: false },
        { plugin: b, priority: 500, dependencies: ['a'], dependents: ['a'], canExecuteInParallel: false },
      ],
    })
    expect(res.valid).toBe(false)
    expect(res.errors.some((e) => e.includes('Circular dependency'))).toBe(true)
  })
})

describe('PluginExecutor.executePlan', () => {
  it('sequencial: respeita a ordem do plano, um de cada vez', async () => {
    const executor = new PluginExecutor(memoryLogger())
    const plugins = [
      plugin('c', { setup: noop, dependencies: ['b'] }),
      plugin('b', { setup: noop, dependencies: ['a'] }),
      plugin('a', { setup: noop }),
    ]
    const plan = executor.createExecutionPlan(plugins, 'setup')
    const log: string[] = []
    let running = 0
    const results = await executor.executePlan(plan, { ctx: 1 }, async (p, hook, ctx) => {
      running++
      expect(running).toBe(1)
      expect(ctx).toEqual({ ctx: 1 })
      log.push(p.name)
      await new Promise((r) => setTimeout(r, 2))
      running--
      return okResult(p, hook)
    })
    expect(log).toEqual(['a', 'b', 'c'])
    expect(results.map((r) => r.plugin)).toEqual(['a', 'b', 'c'])
  })

  it('paralelo: grupos por dependência; independentes rodam juntos', async () => {
    const executor = new PluginExecutor(memoryLogger())
    const plugins = [
      plugin('x', { onBuild: noop }),
      plugin('y', { onBuild: noop }),
      plugin('z', { onBuild: noop, dependencies: ['x', 'y'] }),
    ]
    const plan = executor.createExecutionPlan(plugins, 'onBuild', { parallel: true })
    expect(plan.parallel).toBe(true)

    const started: string[] = []
    const finished: string[] = []
    let maxConcurrent = 0
    let running = 0
    await executor.executePlan(plan, undefined, async (p, hook) => {
      started.push(p.name)
      running++
      maxConcurrent = Math.max(maxConcurrent, running)
      await new Promise((r) => setTimeout(r, 10))
      running--
      finished.push(p.name)
      return okResult(p, hook)
    })
    expect(maxConcurrent).toBe(2) // x e y juntos
    // z só começa depois de x e y terminarem
    expect(started.indexOf('z')).toBe(2)
    expect(finished.slice(0, 2).sort()).toEqual(['x', 'y'])
  })

  it('paralelo: rejeição de um plugin vira resultado de falha e não derruba o grupo', async () => {
    const executor = new PluginExecutor(memoryLogger())
    const plan = executor.createExecutionPlan(
      [plugin('ok', { onBuild: noop }), plugin('boom', { onBuild: noop })],
      'onBuild',
      { parallel: true },
    )
    const results = await executor.executePlan(plan, undefined, async (p, hook) => {
      if (p.name === 'boom') throw new Error('falhou')
      return okResult(p, hook)
    })
    const byName = Object.fromEntries(results.map((r) => [r.plugin, r]))
    expect(byName.ok.success).toBe(true)
    expect(byName.boom).toMatchObject({ success: false, plugin: 'boom', hook: 'onBuild', duration: 0 })
    expect(String(byName.boom.error)).toMatch(/falhou/)
  })

  it('paralelo: dependência que não implementa o hook não trava o plano', async () => {
    const executor = new PluginExecutor(memoryLogger())
    const plan = executor.createExecutionPlan(
      [plugin('a', { onBuild: noop, dependencies: ['sem-hook'] }), plugin('sem-hook')],
      'onBuild',
      { parallel: true },
    )
    const results = await executor.executePlan(plan, undefined, async (p, hook) => okResult(p, hook))
    expect(results.map((r) => r.plugin)).toEqual(['a'])
  })

  it('sequencial: exceção do executor propaga (quem chama trata)', async () => {
    const executor = new PluginExecutor(memoryLogger())
    const plan = executor.createExecutionPlan([plugin('a', { setup: noop })], 'setup')
    await expect(executor.executePlan(plan, undefined, async () => { throw new Error('x') })).rejects.toThrow('x')
  })
})

describe('calculateExecutionStats', () => {
  it('agrega sucesso/falha, duração, mais lento e mais rápido', () => {
    const stats = calculateExecutionStats([
      { success: true, duration: 10, plugin: 'a', hook: 'setup' },
      { success: false, duration: 30, plugin: 'b', hook: 'setup' },
      { success: true, duration: 5, plugin: 'c', hook: 'setup' },
    ])
    expect(stats).toEqual({
      totalPlugins: 3,
      successfulPlugins: 2,
      failedPlugins: 1,
      totalDuration: 45,
      averageDuration: 15,
      slowestPlugin: { name: 'b', duration: 30 },
      fastestPlugin: { name: 'c', duration: 5 },
    })
  })

  it('lista vazia', () => {
    expect(calculateExecutionStats([])).toMatchObject({ totalPlugins: 0, averageDuration: 0, slowestPlugin: null, fastestPlugin: null })
  })
})
