# 06 — `@fluxstack/plugin-kit` (runtime de plugins)

**Pacote:** `packages/plugin-kit` (`@fluxstack/plugin-kit` **0.4.0**) — **NOVO**, extraído em abril/2026.
**Cobre:** tipos (manifest/hooks/context/logger) + runtime (discovery, executor, manager, registry).

> Este é o **motor** do sistema de plugins. O **FluxStack app** o consome via
> `FluxStack/core/plugins` (shim que especializa os tipos genéricos contra
> `FluxStackConfig`). Para o sistema de plugins do ponto de vista da app, ver
> `FluxStack/specs/03-plugin-system.md` — esta spec é o lado do toolkit.

---

## 1. Conhecimento

### 1.1 `PluginManager<TConfig>` — `runtime/manager.ts:76-281`

Orquestra o ciclo de vida:
- `initialize()` · `registerPlugin()` · `unregisterPlugin()` ·
  `executeHook(hook, context, options)` · `getPluginMetrics()`.
- Fluxo: roda `setup` em todos os plugins habilitados; emite eventos
  `hook:before`/`hook:after`/`hook:error`; **retry com backoff exponencial**;
  **timeout 30s default**.
- Contexto = `PluginContext<TConfig>` { `config`, `logger` (child), `app` handle,
  `registry`, `clientHooks` API }.

> **Mudança estrutural (0.4.0):** **discovery filesystem foi removido do
> `initialize()`**. Host apps **devem registrar plugins explicitamente** via `.use()`.
> `PluginDiscovery.discoverAll()` ainda existe, mas **não roda automaticamente** no boot.
> **Evidência:** `manager.ts:101-117` (comentário), `discovery.ts:107-113`.

### 1.2 `PluginExecutor` — ordem topológica — `runtime/executor.ts:39-275`

- **Priority** (enum): `highest`=1000, `high`=750, `normal`=500, `low`=250, `lowest`=0.
- Plugins declaram `dependencies: string[]`. Executor faz **topological sort**,
  detecta ciclos (`PluginError 'CIRCULAR_DEPENDENCY'`), cria **parallel groups**
  (`canExecuteInParallel`) rodados em `Promise.allSettled()`.
- `validateExecutionPlan()` checa deps ausentes e ciclos.

### 1.3 `PluginDiscovery` (3 sources) — `runtime/discovery.ts:35-351`

Scaneia **built-in** (`core/plugins/built-in/`), **external** (`plugins/`), **npm**
(`node_modules/fluxstack-plugin-*`). Manifest via `plugin.json` ou
`package.json#fluxstack`. Entry points: `index.{ts,js}`, `plugin.{ts,js}`,
`src/index.{ts,js}`, `dist/index.js`. `isValidPlugin()`: `name` não vazio, hooks são
funções. `validateManifestCompatibility()`: warna mismatch nome/versão e hooks
declarados vs implementados.

### 1.4 `Plugin` (interface) — tipos

```ts
interface Plugin<TConfig> {
  name: string; version?; description?; author?
  dependencies?: string[]; priority?; category?; tags?
  // hooks (todos opcionais)
  setup?; onConfigLoad?
  onBeforeServerStart?; onServerStart?; onAfterServerStart?
  onBeforeServerStop?; onServerStop?
  onRequest?; onRequestValidation?; onBeforeRoute?; onAfterRoute?
  onBeforeResponse?; onResponseTransform?; onResponse?
  onError?
  onBeforeBuild?; onBuild?; onBuildAsset?; onBuildComplete?
}
```

(A app especializa via `type Plugin = BasePlugin<FluxStackConfig>` em
`FluxStack/core/plugins/types.ts:33-38`.)

---

## 2. Pontos de falha (confirmados)

### 🟠 FP-1 — Whitelist NPM não é checada no registro manual (`.use()`)
`isPluginAllowed()` (`registry.ts:340-373`) só é chamada na **descoberta automática**
(`:514, :542`), **não** no `registerSync()` (`:267`). Como tudo agora é registro
manual via `.use()`, a whitelist `PLUGINS_ALLOWED` **nunca é enforçada** em runtime
— um plugin NPM pode ser `.use()`-d sem estar na whitelist. **Evidência:**
`registry.ts:267-284, 340-373, 727-759`.
**Severidade:** 🟠 (a "segurança em camadas" anunciada no CLAUDE.md é, na prática,
inativa para o caminho real de registro). **Fix:** `registerSync()` deve classificar
a origem do plugin (built-in/project/npm) e enforçar whitelist para npm — ou remover
a promessa de whitelist da doc.

### 🟡 FP-2 — `PluginClientHooksAPI` shape assumido sem validação
Plugins (ex.: csrf) assumem que `context.clientHooks.register(hook, code)` existe; se
o host não prover, **falha silenciosa**. **Fix:** validar a interface no setup do contexto.

### 🟡 FP-3 — Hooks são estáticos pós-boot (sem hot-reload)
Não há `registerPlugin()` + `executeHook('setup')` em runtime — plugins não podem ser
adicionados sem restart. **Fix:** suportar registro em runtime (dev experience).

---

## 3. O que precisa mudar

| Prio | Item |
|---|---|
| 🟠 | **Enforçar whitelist NPM no `registerSync`/`.use()`** (FP-1) — ou alinhar a doc à realidade (sem auto-discovery, sem enforcement). |
| 🟡 | Validar `PluginClientHooksAPI` no setup do contexto (FP-2). |
| 🟡 | Validar que **todas** as `dependencies` declaradas existem no registry após init. |
| 🟡 | Cleanup do `requestTimings` Map (timer > 60s ou WeakMap) — evita memory leak em apps de alta frequência. |

---

## 4. Ideias de melhoria

| Impacto | Ideia |
|---|---|
| 🟡 | **Auto-detecção de manifest** — ler `plugin.json`/`package.json#fluxstack` automaticamente no `.use()` (hooks/deps/priority sem duplicação). |
| 🟡 | **`onBeforeShutdown` hook** — antes de `onServerStop`, para cleanup ordenado de recursos async (connections, timers). |
| 🟡 | **Hot-reload de config** — `onConfigReload` que plugins implementam (FP-3). |
| 🟡 | **Grafo de dependências** — `buildDependencyGraph()` + comando CLI `plugin:graph` (ASCII/JSON), mostra ciclos. |
| ⚪ | **Timeout por-plugin** — `timeout?: number` na interface (hoje é global 30s). |
| ⚪ | **Métricas Prometheus** — durações de hook, error rates via `/metrics`. |

---

## 5. Arquivos-chave

`plugin-kit/src/index.ts` · `runtime/{manager,executor,discovery,registry,module-resolver,dependency-manager,errors}.ts` ·
`types/{plugin,hooks,context,manifest,logger,cli}.ts`.
