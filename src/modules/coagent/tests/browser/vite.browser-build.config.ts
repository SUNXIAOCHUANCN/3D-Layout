/**
 * W02 浏览器验证页的模块内生产构建配置（SPEC §W02："构建产物无意外 Node-only 依赖"）。
 * 独立于宿主 vite.config——只构建本目录的 index.html（probe 页），
 * 产物落 tests/browser/dist-w02（验证后删除）。
 * 运行：pnpm build:coagent-probe（在 src/ 下）。
 */

import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  build: {
    outDir: 'dist-w02',
    emptyOutDir: true,
  },
})
