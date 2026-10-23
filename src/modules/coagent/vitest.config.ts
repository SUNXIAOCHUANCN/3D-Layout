/**
 * CoAgent 测试配置（W01）。
 * 测试源码与配置都留在模块内（SPEC §W01），不动宿主 tsconfig。
 * 运行：pnpm test:coagent（在 src/ 下执行）。
 * 浏览器层测试（T10/T11/T13/T16）由 W04+ 另行引入 playwright，不在此配置。
 */

import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
