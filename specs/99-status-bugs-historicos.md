# 99 — Status dos bugs históricos (bug-hunt abril/2026)

Em 2026-04-10, 5 agentes em paralelo escreveram testes reprodutores e confirmaram
**16+ bugs** (`.ai-notes/bugs/2026-04-10-bug-hunt-consolidated.md`). Esta tabela
registra o **status verificado em 2026-06-09** (cada item foi conferido lendo o
código atual + testes). **Não retrabalhe os itais marcados "CORRIGIDO".**

## ✅ Corrigidos (com teste de regressão)

| # | Bug original | Status hoje | Evidência |
|---|---|---|---|
| #1/#16 | Replay attack após nonce eviction | **CORRIGIDO** — `evictionHighWaterMark` fail-closed; nonce com `ts<=mark` rejeitado | `StateSignature.ts:75,150-152,386-410`; `StateSignature.replay-eviction.test.ts` |
| #2 | `$auth.session` mutável | **CORRIGIDO** — `Object.freeze(session)` + roles/permissions copiados e congelados | `LiveAuthContext.ts:20-37`; `session-freeze.test.ts:29-36` |
| #3/#5 | `onCreate` sem try/catch, sem await, ordem invertida | **CORRIGIDO** — `await` + try/catch, e `onCreate` roda **antes** de `onJoin` | `LiveRoomManager.ts:217-225,242-250` |
| #4 | `onEvent` sem try/catch | **CORRIGIDO** — isolado em `RoomEventBus` e `LiveRoomManager` | `RoomEventBus.ts:217-222`; `LiveRoomManager.ts:490-501` |
| #5b | `onDestroy` não desembrulha Promise | **CORRIGIDO** — `const result = await ...onDestroy(); if (result===false) return` | `LiveRoomManager.ts:388-389`; `lifecycle-hooks.test.ts:228-253` |
| #6 | `cleanupComponent` não isola throws em `onLeave` | **CORRIGIDO** — try/catch por iteração; `componentRooms.delete` sempre roda | `LiveRoomManager.ts:413-448`; `lifecycle-hooks.test.ts:308-354` |
| #7 | `setState({x:null})` top-level deletava key | **CORRIGIDO** — depth 0 = valor real, depth>0 = delete | `deepDiff.ts:148-156`; `setstate-edge-cases.test.ts:51-127` |
| #9/#10 | `componentId > 255 bytes` truncava (u8) | **CORRIGIDO** — `assertU8Length()` lança erro em todos os framers | `RoomCodec.ts:445-452,478,511,538`; `ComponentStateManager.ts:178-185` |
| #11 | msgpack sem seen-set (stack overflow circular) | **CORRIGIDO** — seen Set + throw | `RoomCodec.ts:37-189` |
| #12 | `WsSendBatcher` engolia erros no flush | **CORRIGIDO** — `catch` com `liveWarn` + `droppedSerializationError` | `WsSendBatcher.ts:242-249,359-361` |
| #14 | ordem binary vs batched invertida | **CORRIGIDO** — `sendBinaryImmediate` faz `flushOne` antes | `WsSendBatcher.ts` |
| #15 | msgpack decode silencioso em underrun | **CORRIGIDO** — valida `offset+N<=len`, throw | `RoomCodec.ts` |
| — | JSON.stringify por cliente no broadcast | **OTIMIZADO** — serialize-once + dedup de delta | `ComponentRegistry.ts:748-755`; `WsSendBatcher.ts:285-335` |

## ⚠️ Parcial / observabilizado (não totalmente resolvido)

| # | Bug | Status | Onde tratamos |
|---|---|---|---|
| #8 | `undefined` em `setState` | **PARCIAL** — não vaza mais para o wire (skip), mas **falta** o erro defensivo (`undefined` é no-op silencioso) | `01` FP-3 |
| #13 | Backpressure FIFO-drop silencioso | **✅ CORRIGIDO (2026-06-10)** — telemetria + resync handler default no `LiveServer` reenvia snapshot assinado; cliente recupera. Testado. | `02` FP-1 |
| — | Race na eviction de nonce (delete↔mark) + clock-skew | **AINDA PRESENTE** — janela estreita explorável com SignedState capturado | `03` FP-1 |

## ❌ Ainda presentes (design ou não corrigidos)

| Tema | Status | Onde |
|---|---|---|
| Broadcast **O(n²)** em sala compartilhada | **trade-off de design** (não bug) — 31× mais lento que salas isoladas | `01` FP-2 / `02` FP-2 |
| Proxy **shallow** (mutação nested não emite delta) | **limitação conhecida**, sem warn | `01` FP-1 |
| `LiveAuthContext` permite provider **não-freezado** | tipo permissivo; reabre #2 se mal usado | `03` FP-2 |
| Whitelist NPM **não enforçada** no `.use()` manual | segurança em camadas inativa na prática | `06` FP-1 |
| ~~`RedisRoomAdapter.publishStateChange` não-atômico~~ | **✅ CORRIGIDO (2026-06-10)** — Lua script atômico; testado com 100 escritas concorrentes | `05` FP-1 |
| AES-256-CBC **sem autenticação** (state crypto opcional) | tampering não detectado | `03` FP-3 |

## Como manter esta tabela

Ao corrigir um item "presente/parcial", mova-o para "Corrigidos" com a evidência do
teste de regressão. Ao reportar um bug novo, registre-o na spec do subsistema (`01`–`06`)
e, se for relevante historicamente, referencie aqui.
