import { defineConfig } from 'tsup'

export default defineConfig([
  // ESM build for npm/bundler consumption
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'es2022',
    external: ['@fluxstack/live'],
  },
  // IIFE browser build (self-contained, exposes window.FluxstackLive)
  {
    entry: { 'live-client.browser': 'src/index.ts' },
    format: ['iife'],
    globalName: 'FluxstackLive',
    sourcemap: true,
    target: 'es2020',
    noExternal: ['@fluxstack/live'],
    outDir: 'dist',
  },
])
