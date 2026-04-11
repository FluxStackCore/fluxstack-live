# @fluxstack/plugin-kit

Shared plugin system for FluxStack. Single source of truth for plugin types
and (starting in v0.3.0) the plugin manager runtime. Consumed by the FluxStack
app itself and by external plugin packages.

## Status

**v0.1.0** — scaffolding only. No types or runtime exported yet.

See the [extraction plan](../../../.ai-notes/plans/2026-04-11-plugin-kit-extraction.md)
for the roadmap.

## Relationship to `@fluxstack/sdk`

`@fluxstack/sdk@1.0.0` is the **predecessor** of this package. It was a static
copy of plugin types + a duplicate of `@fluxstack/config`. Plugin-kit replaces
it with a single canonical source consumed from both sides (app and plugins).

`@fluxstack/sdk` will be deprecated on npm once plugin-kit reaches v1.0.0.

## Building

```bash
# From the monorepo root:
bun run build:plugin-kit

# Or from this directory:
bun run build       # → dist/ (ESM + CJS + .d.ts)
bun run typecheck
```

## Release strategy

Plugin-kit is **not** in the `PACKAGES` array of `scripts/publish.sh` yet.
While it's iterating (phases 2-3 of the extraction plan), publish it manually
with `cd packages/plugin-kit && npm publish`. This avoids forcing cross-bumps
with `@fluxstack/live` during unstable phases. Once it stabilizes at v1.0.0,
add it to `publish.sh` so future releases ship alongside the rest of the
monorepo.
