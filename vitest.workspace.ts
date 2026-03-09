import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  'packages/core',
  'packages/redis',
  'packages/elysia',
  'packages/express',
  'packages/fastify',
  'packages/client',
  'packages/react',
  '__tests__',
])
