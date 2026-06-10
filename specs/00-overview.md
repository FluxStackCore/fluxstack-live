# 00 — Overview do monorepo `fluxstack-live`

**Versão de referência:** `@fluxstack/live` **0.10.0** · varredura **2026-06-09**

## O que é

`@fluxstack/live` é um framework realtime onde **LiveComponents** — classes
server-side com estado reativo — sincronizam automaticamente seu estado para os
clientes via WebSocket. O modelo é inspirado em Phoenix LiveView, mas **não faz
DOM patching**: é puro *state sync* (server envia deltas de estado; o client
faz merge e re-renderiza via React/Vue/vanilla). Ver `04` para o desmentido do
"DOM patching" que aparece em docs antigas.

## Pacotes e versões reais

| Pacote (dir) | npm | Versão | Papel |
|---|---|---|---|
| `core` | `@fluxstack/live` | **0.10.0** | Engine: LiveComponent, LiveServer, LiveRoom, auth, security, codec, cluster |
| `client` | `@fluxstack/live-client` | **0.10.0** | WebSocket client (vanilla), reconexão, codec binário, rooms, upload |
| `react` | `@fluxstack/live-react` | **0.10.0** | `Live.use()`, Provider, `Live.Boundary`/`Live.Status`, connection pool |
| `elysia` | `@fluxstack/live-elysia` | **0.10.0** | Transport adapter Elysia/Bun |
| `vue` | `@fluxstack/live-vue` | 0.9.0 | Composables Vue 3 |
| `express` | `@fluxstack/live-express` | 0.9.0 | Transport adapter Express |
| `fastify` | `@fluxstack/live-fastify` | 0.9.0 | Transport adapter Fastify |
| `redis` | `@fluxstack/live-redis` | 0.9.0 | `RedisClusterAdapter` + `RedisRoomAdapter` |
| `cli` | `@fluxstack/live-cli` | 0.9.0 | **NOVO** — inspector WS interativo + decoder msgpack |
| `plugin-kit` | `@fluxstack/plugin-kit` | **0.4.0** | **NOVO** — runtime de plugins (usado pelo FluxStack core) |
| `spatial-room` | `@fluxstack/spatial-room` | 0.9.0 | **NOVO** — interest management (grid 2D/3D) p/ jogos |

> ⚠️ `core/client/react/elysia` estão à frente (`0.10.0`) dos demais (`0.9.0`).
> `cli`, `plugin-kit` e `spatial-room` **não aparecem** em `llms.txt`/`CLAUDE.md`.

## Naturezas de componente (mapa mental)

- **LiveComponent** — classe server-side; estado realtime sincronizado por WS. O trunfo.
- **Singleton** (`static singleton = true`) — uma instância para todos os clients;
  coordenada entre instâncias de servidor via cluster adapter.
- **LiveRoom** — sala tipada (`<TState, TMeta, TEvents>`) com estado compartilhado
  + eventos; broadcast por msgpack binário.

## Regra crítica de build (Windows)

O backend (Bun) resolve `@fluxstack/live-*` de `dist/` (compilado). **Após editar
`packages/*/src/`, rebuildar antes de testar no app FluxStack.** O frontend Vite
usa aliases para o source `.ts` direto (não precisa build).

```bash
cd fluxstack-live
bun run build:core       # após mudar core/src
bun run build:client     # após mudar client/src
bun run build:react      # após mudar react/src
# Windows: build:adapters usa POSIX & e falha — rode individual:
cd packages/elysia && bunx tsup
```

**Gaps de build conhecidos** (ver `05`): `redis`, `vue`, `spatial-room` **não têm
script dedicado** no `package.json` raiz e **não entram** no `bun run build`.
Quem mexer neles tem de rodar `bunx tsup` manual no pacote. → *changes needed* em `05`.

## Como navegar as specs

Comece por `01` (component/state) — é o núcleo. `02` cobre rooms+protocolo binário.
`03` é segurança/server/cluster. `04` é client/react. `05` são os pacotes
periféricos. `06` é o plugin-kit. `99` traça o status dos bugs históricos.
