# 05 — Adapters, Redis, Vue, CLI & Spatial-Room

**Pacotes:** `elysia`/`express`/`fastify`, `redis`, `vue`, `cli`, `spatial-room`.
**Estado:** `cli` e `spatial-room` são **novos e não documentados** fora desta spec.

---

## 1. Conhecimento

### 1.1 Transport adapters — `LiveTransport` / `GenericWebSocket`

Adapters implementam `LiveTransport`: `registerWebSocket(config)`,
`registerHttpRoutes(routes)`, `registerClientBundle(path)`, `shutdown()`. Eles
**não são puro pass-through** — fazem normalização real do WS nativo em
`GenericWebSocket` (`send/close/data/remoteAddress/readyState`):

| Adapter | Padrão | Evidência |
|---|---|---|
| **elysia** | wrappa `ServerWebSocket` do Bun (data slot), serve client bundle | `elysia/src/index.ts:166-198` |
| **express** | cria `WebSocketServer` (lib `ws`) + hook em `app.listen()`; `live()` middleware plug-and-play; shutdown SIGINT/SIGTERM | `express/src/index.ts:163-193, 328-387` |
| **fastify** | plugin via `fastify-plugin` + `@fastify/websocket`; decora `FastifyInstance.liveServer`; module augmentation | `fastify/src/index.ts:151-180, 317-335` |

### 1.2 Redis — dois adapters — `packages/redis/src`

**`RedisClusterAdapter`** (`IClusterAdapter`) — coordenação de singletons:
- Claim atômico via **`SET NX EX`** (`instanceId:componentId`, TTL 30s) — `:173-185`.
- **Heartbeat** a cada 10s renova via `EXPIRE`, **verifica ownership antes** (split-brain) — `:384-414`.
- Crash → claim expira → novo owner recupera state de `singleton-state:{name}`.
- Action forwarding via `publish()` em canais por-instância; deltas no canal global — `:234-257, 335-338`.

**`RedisRoomAdapter`** (`IRoomPubSubAdapter`) — pub/sub de rooms:
- Pub/sub por sala (`fluxstack:room:ch:{roomId}`); persiste state (TTL 24h) → instância
  nova que entra recupera o state anterior; tracking de membership; echo prevention
  via `instanceId` de origem — `:121-213`.

### 1.3 Vue 3 — `packages/vue/src/index.ts`

`provideLiveConnection` (provider) + `useLiveComponent` (composable reativo).
`deepMerge` aplica `STATE_DELTA` com a semântica null-as-deletion (top-level null real,
nested null deleta, undefined no-op) — `:52-78`.

### 1.4 CLI inspector (NOVO) — `packages/cli/src`

Ferramenta standalone (`bunx fluxstack-inspect`) que conecta no WS e **introspecta**
LiveComponents/Rooms ao vivo:
- Comandos interativos: `mount`/`unmount`/`action`, ver state, room `join`/`leave`,
  `auth`, enviar JSON cru — `inspector.ts:1-496`.
- Captura mensagens JSON **e binárias** (decoder msgpack próprio, zero-deps,
  `msgpack.ts:1-132`); output colorido (ANSI) com timestamp/direção/tipo.

### 1.5 Spatial-Room (NOVO) — interest management — `packages/spatial-room/src`

Para jogos com centenas+ de entidades, mitiga o broadcast O(n²):
- **`SpatialGrid`** — grid uniforme 2D/3D cell-based; `setPosition` O(1); maps
  simétricos member↔cell; `queryNearMember` em range de cells; cells esparsas — `SpatialGrid.ts:30-211`.
- **`SpatialLiveRoom`** (subclasse de `LiveRoom`) — `emitNearby(componentId, event, data)`
  só para membros visíveis; `emitAtPosition(pos, ...)` mundo-cêntrico; fallback global — `:83-120`.
- **`ChunkRoom`** — especialização 3D voxel/Minecraft (cellSize=16, helpers chunk↔world) — `ChunkRoom.ts:77-107`.

---

## 2. Pontos de falha (confirmados)

### 🟠 FP-1 — `RedisRoomAdapter.publishStateChange()` não era atômico  ✅ CORRIGIDO (2026-06-10)
Era `GET` → `Object.assign` em memória → `SET`, sem atomicidade: entre GET e SET,
outra instância podia modificar o state e o SET o **sobrescrevia silenciosamente**
(perda de dados cross-instance).
> **Fix aplicado:** GET + shallow-merge + SET agora rodam **atomicamente** num **Lua
> script** (`MERGE_STATE_LUA` via `redis.eval`), server-side, com merge campo-a-campo
> via `cjson` e TTL preservado. Valor existente corrompido → começa do zero (mesmo
> comportamento de antes). `RedisRoomAdapter.ts:MERGE_STATE_LUA/publishStateChange`.
> **Teste:** `redis/src/__tests__/RedisRoomAdapter.test.ts` — 50×2 escritas concorrentes
> de duas instâncias; todos os 100 campos sobrevivem. Sanity TDD: falhava (`undefined`)
> com a versão GET+assign+SET. Requer Redis (Docker :16379).

### 🟡 FP-2 — Cluster delta sem versão/dedup  ✅ CORRIGIDO (2026-06-10)
Era: `publishDelta()` sem version → redelivery do pub/sub (reconexão) ou reordenação
reaplicava deltas duplicadas/velhas, sobrescrevendo estado novo.
> **Fix:** `publishDelta` estampa um **`seq` monotônico por componente**; `handleDelta`
> descarta `seq <= último visto` por `(origin, componentId)` (dedup + ordenação).
> Mensagens sem `seq` (publishers antigos) passam (back-compat).
> `RedisClusterAdapter.ts:publishDelta/handleDelta`. **Testes:**
> `RedisClusterAdapter.delta-dedup.test.ts` (6, com stub — sem Docker).

### 🟡 FP-3 — `cli` msgpack sem guarda de profundidade  ✅ CORRIGIDO (2026-06-10)
Era: decoder recursivo sem limite → frame com aninhamento profundo estourava a stack.
> **Fix:** `decodeMsgpack(buf, maxDepth=100)` propaga `depth` por toda a recursão e
> lança `RangeError` ao exceder. `cli/src/msgpack.ts`. **Testes:** `cli/src/__tests__/msgpack.test.ts`
> (6 — incl. 5000 níveis → RangeError). O pacote `cli` entrou no `vitest.workspace.ts`
> (antes não tinha testes).

### ⚪ FP-4 — Vue `useLiveComponent` sem auto-reconnect
Diferente do client React, o composable Vue **não** reconecta sozinho se o WS cai.

---

## 3. O que precisa mudar

| Prio | Item | Detalhe |
|---|---|---|
| ✅ | ~~**Atomicidade no `RedisRoomAdapter`**~~ | FP-1 — **CORRIGIDO** via Lua script (`MERGE_STATE_LUA`). |
| ✅ | ~~**Build scripts faltando**~~ | **CORRIGIDO (2026-06-10):** adicionados `build:redis`, `build:vue`, `build:spatial` ao `package.json` e incluídos no `bun run build` agregado. |
| 🟠 | **Documentar estes pacotes** | `CLAUDE.md`/`llms.txt` mencionam só core/client/react. Adapters (GenericWebSocket), Redis (atomicidade/heartbeat/failover), Vue, CLI e `spatial-room` precisam de seção própria. |
| ✅ | ~~Versionar/deduplicar cluster deltas~~ | FP-2 — CORRIGIDO (seq monotônico). |
| ✅ | ~~`--max-depth` no msgpack do CLI~~ | FP-3 — CORRIGIDO (maxDepth=100). |
| ⚪ | Vue: auto-reconnect com backoff + replay | FP-4. |

---

## 4. Ideias de melhoria

| Impacto | Ideia |
|---|---|
| 🟠 | **Quadtree/Octree no spatial-room** — grid uniforme não lida bem com hotspots (cidades densas). Árvore adaptativa reduz lookups em áreas vazias. |
| 🟠 | **Lua script atômico no Redis** — `publishStateChange` + update remoto num `EVAL` (resolve FP-1 e corta round-trips). |
| 🟡 | **CLI: modo batch/streaming** (`--output file.jsonl`) + filtro por caminho de delta (`--break-on 'state.player.x'`) + diff before/after (`--show-diff`). |
| 🟡 | **`emitAtDistance()` por distância euclidiana** no spatial (útil p/ fog-of-war). |
| ⚪ | **Métricas Prometheus** (`GET /metrics`) nos adapters: conexões/rooms/componentes/latência P95. |

---

## 5. Arquivos-chave

`{elysia,express,fastify}/src/index.ts` · `redis/src/{RedisClusterAdapter,RedisRoomAdapter,index}.ts` ·
`vue/src/index.ts` · `cli/src/{inspector,msgpack,colors,format,index}.ts` ·
`spatial-room/src/{SpatialLiveRoom,SpatialGrid,ChunkRoom,index}.ts`.
