import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  external: ['fastify', '@fastify/websocket', '@fastify/static', 'ws', '@fluxstack/live', '@fluxstack/live-client', 'fastify-plugin'],
})
