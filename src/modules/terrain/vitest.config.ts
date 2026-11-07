import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { environment: 'node', include: ['modules/terrain/tests/**/*.test.ts', 'modules/llm-agent/tests/**/*.test.ts'] } })
