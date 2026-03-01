import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  'packages/core',
  'packages/elysia',
  'packages/express',
  'packages/client',
  'packages/react',
])
