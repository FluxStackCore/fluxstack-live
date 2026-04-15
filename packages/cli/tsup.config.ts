import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: { inspector: 'src/inspector.ts' },
    format: ['esm'],
    target: 'es2022',
    dts: true,
    clean: true,
    banner: { js: '#!/usr/bin/env node' },
    splitting: false,
  },
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    target: 'es2022',
    dts: true,
    clean: false,
    splitting: false,
  },
])
