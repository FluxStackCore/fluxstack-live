# 01 — Core: LiveComponent & State Management

**Pacote:** `packages/core` (`@fluxstack/live` 0.10.0)
**Cobre:** `LiveComponent`, state proxy/diff, `ComponentRegistry`, managers, `deepDiff`, `generateId`.

O coração do framework. `LiveComponent` é uma classe base abstrata que delega para
managers focados (composição, não herança gorda):

- `ComponentStateManager` — state reativo, proxy, deep diff, envio binário
- `ComponentMessaging` — `emit()` / `broadcast()` via `WsSendBatcher`
- `ActionSecurityManager` — validação de action, rate limit, Zod, `onAction`
- `ComponentRoomProxy` — `$room` / `$rooms`, eventos de sala

`LiveComponent.ts` ≈ 411 linhas; `ComponentRegistry.ts` ≈ 951 linhas.

---

## 1. Conhecimento

### 1.1 Anatomia da classe (`LiveComponent.ts`)

```ts
abstract class LiveComponent<TState, TPrivate> {
  // Estáticos (configuram o componente)
  static componentName: string
  static defaultState: any
  static publicActions?: readonly string[]        // allowlist de actions chamáveis
  static auth?: LiveComponentAuth                  // ver spec 03
  static actionAuth?: LiveActionAuthMap            // auth por action
  static actionSchemas?: Record<string, ZodLike>   // valida payload (safeParse)
  static actionRateLimit?: { maxCalls, windowMs, perAction? }
  static singleton?: boolean                       // 1 instância p/ todos
  static logging?: boolean | LogCategory[]         // silencioso por padrão
  static persistent?: Record<string, any>          // sobrevive HMR reload
  static $options?: ComponentOptions               // deepDiff/roomDeepDiff/depth/serverOnly

  // Três níveis de estado
  state: TState        // proxy reativo — client LÊ e ESCREVE (via actions)
  $private: TPrivate   // server-only — client NUNCA vê
  $auth: LiveAuthContext // setado pelo framework, frozen, read-only (ver 03)

  // Mutação
  setState(updates | (s) => updates)
}
```

> **Diferença vs docs antigas:** `static logging`, `static persistent` (sobrevive
> HMR) e `$options.deepDiffDepth`/`serverOnlyRoomState` **não estão** em
> `fluxstack-live-packages.md`. **Evidência:** `LiveComponent.ts:43-113`.

### 1.2 `$options` (ComponentOptions) — `LiveComponent.ts:29-41`

| Opção | Default | Efeito |
|---|---|---|
| `deepDiff` | `true` | diff campo-a-campo de objetos planos em `setState()` |
| `roomDeepDiff` | `true` | idem para room state |
| `deepDiffDepth` | `3` | profundidade máx. da recursão do diff |
| `serverOnlyRoomState` | `false` | rejeita `ROOM_STATE_SET` vindo do client |

### 1.3 Lifecycle hooks (todos `protected`, no-op por padrão) — `LiveComponent.ts:287-295`

`onConnect()` · `onMount(): void|Promise` · `onDisconnect()` · `onDestroy()` ·
`onStateChange(changes)` · `onRoomJoin(roomId)` · `onRoomLeave(roomId)` ·
`onRehydrate(prev)` · `onAction(action, payload): void|false|Promise<void|false>`
(retornar `false` cancela a action).

### 1.4 State proxy — `ComponentStateManager.ts:58-80, 214-239`

Proxy **shallow** sobre `_state`. Atribuir uma propriedade (`this.state.x = y`,
ou direto `this.x = y` via `applyDirectAccessors`) emite `STATE_DELTA`.
**Mutações aninhadas NÃO emitem** (`this.state.nested.x = y` muta mas não sincroniza)
— ver ponto de falha FP-1.

`setState()` acumula deltas e emite **1 `STATE_DELTA` por microtask** (batching).
Ex.: `this.state.count++; this.state.lastAction = 'x'` → um único delta.

### 1.5 `deepDiff` — semântica de `null`/`undefined` — `deepDiff.ts:36-92, 123-174`

A peça mais sutil do sistema, e **já corrigida** (era o bug #7/#8 de abril):

| Caso | Top-level (depth 0) | Nested (depth > 0) |
|---|---|---|
| `null` | **valor real** → `{key: null}` | **sentinela de deleção** → `delete key` |
| `undefined` | **skip** (JSON o removeria) | **skip** |
| arrays/objetos não-plain | compara por **referência** (`===`) | idem |

`deepAssign` aplica a inversa. Plain objects passam por `structuredClone()` antes
de atribuir, para quebrar aliasing que corromperia diffs futuros (fix #13).
Guarda contra referência circular via `seen` Set.

> **Footgun documentado:** updates nested têm de ser **objetos completos**. Passar
> parcial faz os campos ausentes virarem removals. Use spread `{...value}`.

### 1.6 `ComponentRegistry.mountComponent()` — `ComponentRegistry.ts:238-462`

Fluxo: (1) lookup da classe → (2) auth check → (3) singleton local/remote/cluster →
(4) cria instância → (5) metadata+logging → (6) emite `STATE_UPDATE` com `signedState`
→ (7) `onConnect()` + `await onMount()` → (8) retorna `componentId` + `initialState`.
No cluster: pré-gera o ID, `claimSingleton` atômico, fallback para remote proxy.

### 1.7 Singletons — `EMIT_OVERRIDE_KEY` — `ComponentRegistry.ts:400-425`

Singletons têm uma função `[EMIT_OVERRIDE_KEY]` que substitui o `emit` padrão:
envia `STATE_DELTA` para **todas** as conexões locais (`singleton.connections` Map)
e depois `cluster.publishDelta` se habilitado. Permite que todos os clients de um
singleton vejam updates sem precisar de room.

### 1.8 `ActionSecurityManager.validateAndExecute()` — `ActionSecurityManager.ts:39-144`

Sequência: (1) `BLOCKED_ACTIONS` → (2) bloqueia prefixos `_`/`#` → (3) `publicActions`
allowlist → (4) método existe? → (5) guarda prototype-pollution → (6) rate limit →
(7) Zod `safeParse` → (8) `await onAction` (pode retornar `false`) → (9) `await method.call()`.
Erros emitem mensagem `ERROR`.

### 1.9 `generateId` — `generateId.ts`

8 chars, alfabeto de 64, ~48 bits de entropia, crypto-random, ~5× mais rápido que
`randomUUID`. (Decisão registrada em `.ai-notes/decisions/2026-04-14`.)

---

## 2. Pontos de falha (confirmados no código atual)

### 🟡 FP-1 — State proxy shallow: mutação aninhada não emite delta
`this.state.nested.x = y` altera o estado interno mas **não** dispara `STATE_DELTA`
→ divergência silenciosa client/server.
**Evidência:** `ComponentStateManager.ts:58-80`.
**Status:** ✅ **RESOLVIDO (opt-in, 2026-06-10).** Agora há `static $options = { recursiveProxy: true }`
que torna o state proxy **recursivo** — `this.state.nested.x = y` é detectado e emite delta
(via snapshot+diff sob a chave raiz), **preservando identidade referencial** (`state.x === state.x`).
Default permanece **shallow** (zero overhead). `ComponentStateManager.ts:wrapChild`. **Testes:**
`__tests__/component/ComponentStateManager.recursive-proxy.test.ts` (8).
> **Nota (2026-06-10):** já existe warn em dev para o caso de **referência
> compartilhada** em `setState` (`ComponentStateManager.ts:93-110`). O warn para
> **mutação nested direta** (`this.state.x.y = z`) foi tentado via tripwire proxy no
> `get`, mas **revertido**: envolver objetos no `get` quebra a identidade referencial
> (`state.x === state.x`) e o short-circuit de same-reference do diff. A única
> correção limpa é **(A) proxy recursivo opt-in via `$options`** — não-cirúrgica,
> fica como melhoria. Por ora, a orientação é: **sempre use `setState()`/spread** para
> nested.

### 🟠 FP-2 — Broadcast O(n²) em sala compartilhada (design)
N clientes na mesma sala → cada action gera N-1 broadcasts; todos enviando = N·(N-1).
Benchmark: 1000 clientes em sala compartilhada = **30.9s** vs salas isoladas = **989ms (31×)**.
A otimização "serialize once" foi aplicada (`ComponentRegistry.ts:748-755`,
`LiveRoomManager.ts:703-744`) e corta CPU/mensagem (~8%), mas o **volume** O(n²)
persiste. **Não é bug — é trade-off documentado.** Mitigação real: `spatial-room`
(interest management) ou repensar o RoomEventBus para broadcast direto (ver `02`).
**Evidência:** `PERFORMANCE-ISSUES.md:18-24,110-116`.

### ⚪ FP-3 — `undefined` em `setState` é no-op silencioso
`setState({x: undefined})` é ignorado (não vaza para o wire — bom), mas **não há
erro defensivo**. O dev que quis limpar um campo com `undefined` não recebe aviso;
deveria usar `null`. **Evidência:** `deepDiff.ts:55-57, 143-146`.
**Status:** comportamento intencional e documentado em comentário; falta apenas a
validação opcional que lançaria erro claro.

> Bugs #6 (`setState({x:null})` deletava key), #9/#10 (componentId > 255 bytes
> truncava) e #16 (replay nonce) que apareciam nas notas antigas **JÁ FORAM
> CORRIGIDOS** — ver `99-status-bugs-historicos.md`.

---

## 3. O que precisa mudar

| Prio | Item | Detalhe |
|---|---|---|
| 🟠 | Política de mutação nested | Decidir e tornar explícito: proxy recursivo, warn-em-dev, ou contrato "use setState". Hoje é footgun silencioso (FP-1). `ComponentStateManager.ts:58-80` |
| 🟠 | Timeout global em hooks async | `onMount/onCreate/onJoin/onDestroy/onLeave` não têm `Promise.race` com timeout. Default 30s, rejeita limpo. |
| 🟡 | Ordem de validação em actions | `onAction` roda **antes** do Zod `safeParse`. Reordenar: schema → hook → execute, para o hook receber payload já validado. `ActionSecurityManager.ts:39-144` |
| 🟡 | Per-field compare mode | Arrays recriados com conteúdo idêntico geram delta inútil (caso de jogos 10Hz). Oferecer `setStateDelta()` explícito ou compare shallow opt-in. `PERFORMANCE-ISSUES.md` issue #3 |
| ⚪ | Deep-freeze de session custom | Freeze de `$auth.session` é shallow; campos nested custom podem ser mutados. Documentar "use primitivos" ou `deepFreeze()`. |

---

## 4. Ideias de melhoria

| Impacto | Ideia |
|---|---|
| 🟠 | **Offline-first / optimistic local patches** — client faz `setState()` local quando desconectado; ao reconectar, merge com server via patch protocol (requer deepDiff client-side, que já existe). |
| 🟠 | **Interest-based subscriptions** — `emitToRoomMembers` já é a base; suportar interest groups (só players próximos recebem). Convergir com `spatial-room`. |
| 🟡 | **Batch action execution** — client envia `[ [action,payload], ... ]` num `CALL_BATCH`; server executa em sequência e emite 1 `STATE_DELTA` final. Reduz round-trips. |
| 🟡 | **State versioning / migrations** — `ComponentRegistry` já rastreia `migrationHistory`; expor hook `onMigrate(from, to)` para transformar state entre versões. |
| 🟡 | **Middleware composável p/ `onAction`** — decorators `@timed`/`@logged`/`@audit` antes/depois da execução. |
| ⚪ | **Distributed tracing** — trace ID no callstack da action, correlacionado com emissões de `STATE_DELTA` e broadcasts. |

---

## 5. Arquivos-chave

| Arquivo | Papel |
|---|---|
| `component/LiveComponent.ts` | Classe base + estáticos + lifecycle |
| `component/ComponentRegistry.ts` | mount/unmount, singletons, cluster, rehydrate |
| `component/managers/ComponentStateManager.ts` | proxy, deep diff, `sendBinaryDelta` |
| `component/managers/ActionSecurityManager.ts` | validação + rate limit + Zod + `onAction` |
| `component/managers/ComponentMessaging.ts` | `emit`/`broadcast` + singleton override |
| `component/managers/ComponentRoomProxy.ts` | `$room`/`$rooms`, eventos de sala |
| `utils/deepDiff.ts` | `computeDeepDiff` + `deepAssign` |
| `utils/generateId.ts` | gerador de IDs otimizado |
