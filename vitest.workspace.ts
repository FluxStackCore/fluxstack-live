import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  'packages/plugin-kit',
  'packages/core',
  'packages/redis',
  'packages/elysia',
  'packages/express',
  'packages/fastify',
  'packages/client',
  'packages/react',
  'packages/spatial-room',
  'packages/cli',
  '__tests__',
])
