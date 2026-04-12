import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/SSRLiveProvider.tsx'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  external: ['react', 'react/jsx-runtime', 'zustand', 'zustand/middleware', '@fluxstack/live', '@fluxstack/live-client'],
})
