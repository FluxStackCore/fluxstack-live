import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: { inspector: 'src/inspector.ts' },
    format: ['esm'],
    target: 'es2022',
    dts: true,
    clean: true,
    // o shebang vem do próprio src/inspector.ts (esbuild preserva); um banner
    // aqui duplicava a linha e o bin quebrava com SyntaxError.
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
