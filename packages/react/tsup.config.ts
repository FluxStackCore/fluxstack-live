import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  external: ['react', 'react/jsx-runtime', 'zustand', 'zustand/middleware', '@fluxstack/live', '@fluxstack/live-client'],
  // Todo o @fluxstack/live-react é CLIENT (Provider, hooks, WebSocket). O esbuild
  // descarta a diretiva 'use client' dos arquivos ao bundlar, então a reinjetamos
  // no topo do bundle — sem ela, importar o pacote num server component RSC quebra
  // com "createContext is not a function" no ambiente react-server.
  banner: { js: "'use client';" },
})
