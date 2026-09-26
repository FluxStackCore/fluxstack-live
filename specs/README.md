# Specs — `@fluxstack/live` (Live Components)

> **Fonte de verdade técnica do monorepo `fluxstack-live`.**
> Gerada por varredura profunda do código real em **2026-06-09** (live `0.10.0`).
> Substitui o conhecimento defasado em `llms.txt` / `.ai-notes/docs/fluxstack-live-packages.md`
> (que descreviam a `0.7.x`). Quando esta spec divergir daqueles, **esta vence**.

## O que é uma "spec" aqui

Cada documento descreve um subsistema com cinco seções padronizadas:

1. **Conhecimento** — como o código realmente funciona, com `arquivo:linha`.
2. **Pontos de falha** — bugs/edge-cases/gotchas **confirmados no código atual**
   (os bugs antigos já corrigidos foram removidos — ver `99-status-bugs-historicos.md`).
3. **O que precisa mudar** — dívida técnica, contratos inconsistentes, docs divergentes.
4. **Ideias de melhoria** — features e refactors propostos, com impacto estimado.
5. **Evidência** — sempre `pacote/src/arquivo.ts:linha`.

Severidades: 🔴 critical · 🟠 high · 🟡 medium · ⚪ low.

## Índice

| Spec | Cobre |
|---|---|
| [00-overview.md](00-overview.md) | Pacotes, versões, mapa do monorepo, build, naturezas de componente |
| [01-core-component-state.md](01-core-component-state.md) | `LiveComponent`, state proxy, `deepDiff`, `ComponentRegistry`, actions, singletons |
| [02-core-rooms-protocol.md](02-core-rooms-protocol.md) | `LiveRoom`, lifecycle, `RoomCodec`/msgpack, frames binários, `WsSendBatcher` |
| [03-core-auth-security-cluster.md](03-core-auth-security-cluster.md) | RBAC, `StateSignature` (HMAC + nonce), `LiveServer`, cluster, upload, rate limit |
| [04-client-react.md](04-client-react.md) | `LiveConnection`, reconexão resiliente, `Live.use()`, `Live.Boundary`, connection pool |
| [05-adapters-redis-vue-cli-spatial.md](05-adapters-redis-vue-cli-spatial.md) | Adapters transport, Redis (cluster+room), Vue, CLI inspector, `spatial-room` |
| [06-plugin-kit.md](06-plugin-kit.md) | `@fluxstack/plugin-kit` — runtime de plugins (discovery, executor, manager) |
| [07-transports.md](07-transports.md) | Transportes modulares: WebSocket, **SSE + POST**, `auto`, custom |
| [99-status-bugs-historicos.md](99-status-bugs-historicos.md) | Bugs do bug-hunt de abril/2026: o que foi corrigido vs o que persiste |

## ✅ Auditoria 2026-09-26 (0.11.0)

| Item | Status |
|---|---|
| `CALL_ACTION` / `PROPERTY_UPDATE` / salas exigem posse do componente pela conexão | ✅ |
| `actionAuth` avaliado com a identidade de quem chama (singletons e forward de cluster) | ✅ |
| `userId` vindo do cliente ignorado — só `authContext.session.id` | ✅ |
| Upload: dono do `uploadId`, `totalChunks` do servidor, teto de bytes, quota por conexão | ✅ |
| `MAX_MESSAGE_SIZE` 100MB → 4MB (configurável), frames binários checados | ✅ |
| Rate limit de action por conexão em singletons | ✅ |
| msgpack do core: limite de profundidade, contagem vs. buffer, `__proto__` | ✅ |
| `catch {}` silenciosos no registry agora logam | ✅ |
| Transporte SSE + transporte plugável no cliente | ✅ ver `07` |
| Versões de todos os pacotes alinhadas em 0.11.0 | ✅ |

Testes novos: `security/multi-user-authorization`, `security/msgpack-decoder-limits`,
`upload/FileUploadManager` (posse e limites), `integration/sse-transport`, `ElysiaSse.bun`.

## Estado do código (2026-06-09)

- Monorepo **maduro** — patches de segurança e performance do bug-hunt de abril
  **majoritariamente aplicados e testados**. Ver `99-status-bugs-historicos.md`.
- Pacotes novos ainda **sem documentação** fora destas specs: `cli`, `spatial-room`, `plugin-kit`.
- O gargalo arquitetural dominante continua sendo o **broadcast O(n²)** em sala
  compartilhada (trade-off de design, não bug) — ver `02` e `05` (spatial-room mitiga).

## ✅ Hardening aplicado (rev. 2026-06-10, com TDD)

| Item | Spec | Status |
|---|---|---|
| Backpressure FIFO-drop → resync no `LiveServer` | `02` FP-1 | ✅ |
| `RedisRoomAdapter.publishStateChange` atômico (Lua) | `05` FP-1 | ✅ |
| Cluster delta sem dedup/ordenação (`seq` monotônico) | `05` FP-2 | ✅ |
| CLI msgpack sem depth guard | `05` FP-3 | ✅ |
| Client decoder: depth guard + decode defensivo | `04` FP-3 | ✅ |
| `LiveAuthContext` provider não-freezado (RBAC) | `03` FP-2 | ✅ |
| Race da eviction de nonce | `03` FP-1 | ✅ verificado/endurecido |
| Whitelist NPM enforçada no `.use()` | `06` FP-1 | ✅ |

**Suítes verdes:** core 1209 · redis 45 · cli 6 · client 107 · plugin-kit 7.
**Ainda abertos** (não-críticos): proxy shallow nested (`01` FP-1), `onEvent` doc (`02` FP-3),
Vue auto-reconnect (`05` FP-4) e o **O(n²)** arquitetural. (AES-GCM: resolvido — `03` FP-3.)
Bugs do bug-hunt de abril: ver `99`.
