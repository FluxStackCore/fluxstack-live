# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Workspace Context

This repo is part of the `FLUX-STACK/` workspace. The parent `../CLAUDE.md` imposes a mandatory `.ai-notes/` shared knowledge base — consult it before starting work and record findings/decisions/bugs there. Additional context files at the repo root: `llms.txt`, `llms-full.txt`, `PERFORMANCE-ISSUES.md`, `CHANGELOG.md`.

## Build Rules

After modifying source code in any package under `packages/`, you MUST rebuild before testing with the FluxStack main application.

The FluxStack app (`../FluxStack`) resolves `@fluxstack/live-*` packages via `node_modules` which points to `dist/` (compiled output), NOT the TypeScript source. Only the Vite frontend uses source aliases for `core`, `client`, and `react` — the backend (Bun) always uses `dist/`.

### Build Commands

```bash
# Rebuild a single package
bun run build:core       # packages/core
bun run build:client     # packages/client
bun run build:react      # packages/react
bun run build:adapters   # packages/elysia, express, fastify (parallel via &)

# Rebuild everything
bun run build            # core -> adapters -> client -> react (sequential)
```

**`vue` and `redis` have NO dedicated build script** in the root `package.json` and are NOT included in `bun run build`. If you modify them, build manually:

```bash
cd packages/vue && bunx tsup
cd packages/redis && bunx tsup
```

**Windows gotcha:** `bun run build:adapters` uses POSIX `&` (background) and fails on Windows cmd/PowerShell. Run the three adapter builds sequentially instead:

```bash
cd packages/elysia && bunx tsup
cd packages/express && bunx tsup
cd packages/fastify && bunx tsup
```

### When to Rebuild

- After ANY change to `packages/core/src/` — rebuild core: `bun run build:core`
- After ANY change to `packages/elysia/src/` — rebuild adapters: `bun run build:adapters`
- After ANY change to `packages/client/src/` — rebuild client: `bun run build:client`
- After ANY change to `packages/react/src/` — rebuild react: `bun run build:react`
- If unsure, rebuild everything: `bun run build`

### Package Resolution in FluxStack

| Package | Backend (Bun) | Frontend (Vite) |
|---|---|---|
| `@fluxstack/live` | `dist/` via node_modules | Source `.ts` via alias |
| `@fluxstack/live-elysia` | `dist/` via node_modules | N/A (backend only) |
| `@fluxstack/live-react` | N/A (frontend only) | Source `.ts` via alias |
| `@fluxstack/live-client` | N/A (frontend only) | Source `.ts` via alias |

## Architecture

Monorepo workspaces: `packages/*` and `examples/*`.

- `packages/core` — Framework-agnostic core (LiveServer, ComponentRegistry, StateSignature, rooms, auth, cluster)
- `packages/elysia` — Elysia.js transport adapter (thin wrapper, no security logic)
- `packages/express` — Express transport adapter
- `packages/fastify` — Fastify transport adapter
- `packages/client` — Browser WebSocket client
- `packages/react` — React hooks and providers (LiveComponentsProvider, Live.use())
- `packages/vue` — Vue 3 composables (provideLiveConnection, useLive)
- `packages/redis` — Redis adapters (RedisRoomAdapter for room pub/sub, RedisClusterAdapter for singleton coordination)

### Core Concepts

- **LiveComponent** — Server class with reactive state synced to clients. Three levels of state:
  - `this.state` — client reads AND writes (bidirectional via actions)
  - `this.$private` — server-only, never sent to client
  - `this.$auth` — set by framework, read-only, frozen
- **LiveRoom** — Typed room (`LiveRoom<TState, TEvents, TMeta>`) with shared state and events; binary msgpack codec by default.
- **Singletons** — `static singleton = true` — one instance shared by all clients. Cluster adapter coordinates singletons across server instances.
- **Auto-discovery** — `componentsPath` option on `LiveServer` scans a directory via dynamic `import()` and generates `auto-generated-components.ts`. On first run, start the server without the import; then add `import { liveComponentClasses } from './components/auto-generated-components'` and pass `components: liveComponentClasses` alongside `componentsPath`. Reason: dev uses dynamic discovery; prod bundlers (e.g. `bun build`) need a static import chain or components end up stripped.
- **Binary frame types** (wire protocol, useful for debugging):
  - `0x02` — Room event broadcast
  - `0x03` — Room state delta (deep diff, msgpack encoded)

### Security Architecture

All security logic lives in `packages/core`. Transport adapters (elysia, express, fastify) are pure pass-through wrappers — they delegate everything to core.

Security features in core:
- HMAC-SHA256 state signing (`StateSignature.ts`)
- Hybrid nonce system: stateless HMAC validation + Map-based replay detection
- Payload sanitization against prototype pollution (`sanitize.ts`)
- Rate limiting (token bucket)
- Authentication (LiveAuthManager)
- Message size limits, room limits

### Cluster Architecture

For horizontal scaling, the cluster adapter (`IClusterAdapter`) coordinates singleton components across server instances.

Key files:
- `packages/core/src/cluster/types.ts` — `IClusterAdapter` interface and all cluster types
- `packages/core/src/cluster/index.ts` — Re-exports
- `packages/redis/src/RedisClusterAdapter.ts` — Redis implementation
- `packages/core/src/component/ComponentRegistry.ts` — Cluster integration (remote singletons, action forwarding, delta handlers)
- `packages/core/src/server/LiveServer.ts` — Accepts `cluster` option, manages lifecycle

Flow:
1. Singleton ownership via atomic Redis `SET NX EX` with pre-generated componentId (no race window)
2. Non-owner servers create `RemoteSingletonEntry` proxies
3. Actions on proxies forwarded via Redis pub/sub → owner executes → result returned
4. State deltas published by owner → proxies relay to local WebSocket clients
5. Heartbeat renews claims every 10s; verifies ownership before renewing (split-brain protection)
6. On crash: claim TTL expires, new owner recovers state from `singleton-state:{name}` key

## Testing

```bash
# Run all tests (uses vitest.workspace.ts: every package + __tests__)
bun run test:run         # one-shot
bun run test             # watch mode
bunx vitest run          # equivalent to test:run

# Run a single test file
bunx vitest run packages/core/src/__tests__/StateSignature.test.ts

# Run tests by name pattern
bunx vitest run -t "deepDiff removes keys"

# Run only one workspace project
bunx vitest run --project core
bunx vitest run --project integration

# Type check (root script = tsc --noEmit across the repo)
bun run lint
# Or per-package
bunx tsc -p packages/core/tsconfig.json --noEmit
```

The root `vitest.workspace.ts` aggregates: `core`, `redis`, `elysia`, `express`, `fastify`, `client`, `react`, and the top-level `__tests__/` (integration). `packages/vue` is NOT in the workspace.

### Cluster Integration Tests

Cluster tests require a running Redis instance. Start one via Docker:

```bash
docker run -d --name fluxstack-test-redis -p 16379:6379 redis:7-alpine
```

Tests are in `__tests__/integration/cluster-sync.test.ts` (monorepo root) and run automatically with the rest of the suite (they skip gracefully if Redis is unavailable).

## Other Scripts

```bash
bun run load-test        # node scripts/load-test.mjs
bun run publish:dry      # bash scripts/publish.sh
bun run publish:npm      # bash scripts/publish.sh --publish
bun run clean            # rm -rf packages/*/dist node_modules
```

## Conventions

- All packages use `tsup` for building (ESM output, ES2022 target)
- Unit tests use `vitest` and live in each package's `src/__tests__/`
- Cross-package integration tests live in `__tests__/` at the monorepo root
- TypeScript strict mode enabled
